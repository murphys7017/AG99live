#include <windows.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <deque>
#include <functional>
#include <iostream>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <string_view>
#include <thread>
#include <unordered_map>
#include <utility>
#include <vector>

#include "ag99/native/microphone_capture.hpp"
#include "ag99/native/playback_ledger.hpp"
#include "ag99/native/runtime_coordinator.hpp"
#include "ag99/runtime/runtime_session.hpp"
#include "ag99/runtime/winhttp_websocket.hpp"

namespace ag99::native {

constexpr double kMaxIncrementalMotionLateTailSeconds = 1.8;

struct NativeRuntimeCoordinator::Impl {
  struct CallbackLifetime {
    std::mutex mutex;
    Impl* owner = nullptr;
  };
  struct AssistantSegment {
    std::string turn_id;
    std::string message_id;
    std::string text;
    bool approved = false;
  };

public:
  explicit Impl(
      RuntimeCoordinatorCallbacks callbacks, RuntimeCoordinatorServices services)
      : services_(std::move(services)),
        microphone_(websocket_),
        callback_lifetime_(std::make_shared<CallbackLifetime>()),
        on_model_sync_(std::move(callbacks.on_model_sync)),
        on_output_segment_(std::move(callbacks.on_output_segment)),
        on_output_segment_reset_(std::move(callbacks.on_output_segment_reset)),
        on_turn_started_(std::move(callbacks.on_turn_started)),
        on_turn_finished_(std::move(callbacks.on_turn_finished)),
        on_turn_interrupted_(std::move(callbacks.on_turn_interrupted)),
        on_desktop_settings_query_(
            std::move(callbacks.on_desktop_settings_query)),
        session_({
            [this](ag99::runtime::OutputSegment segment) {
              OnSegment(std::move(segment));
            },
            [this](ag99::runtime::BinaryAudioChunkFrame) {
              // Binary audio is the microphone ingress path. Playback audio
              // arrives as a cached URL in output.segment.
            },
            [](std::string type) {
              std::cerr << "[runtime] ignored message type: " << type << '\n';
            },
            [](std::string error) {
              std::cerr << "[runtime] protocol error: " << error << '\n';
            },
            [this](ag99::runtime::ModelSync sync) {
              if (on_model_sync_) {
                on_model_sync_(std::move(sync));
              }
            },
            [this](std::string turn_id) {
              BeginTurn(turn_id);
              if (on_turn_started_) {
                on_turn_started_(turn_id);
              }
            },
            [this](std::string turn_id) {
              MarkSynthesisFinished(turn_id);
            },
            [this](std::string turn_id, bool success, std::string reason) {
              RetireTurn(turn_id, !success);
              if (on_turn_finished_) {
                on_turn_finished_(turn_id, success, reason);
              }
            },
            [this](std::string turn_id) {
              RetireTurn(turn_id, true);
              if (on_turn_interrupted_) {
                on_turn_interrupted_(turn_id);
              }
            },
            [this](ag99::runtime::DesktopSettingsQuery query) {
              const auto result = on_desktop_settings_query_
                  ? on_desktop_settings_query_(query)
                  : ag99::runtime::DesktopSettingsResult{
                        query.request_id, query.key, std::nullopt,
                        "desktop_setting_unsupported"};
              const auto reply =
                  ag99::runtime::build_system_desktop_settings_result(result);
              // InvalidateConnection takes session_mutex_ before replacing the
              // socket. Do not take transport_mutex_ from a receive callback.
              if (!websocket_.send_text(reply.dump())) {
                std::cerr << "[runtime] failed to send desktop setting result: "
                          << query.key << '\n';
              }
            },
            [this](ag99::runtime::SegmentMotionUpdate update) {
              OnSegmentMotion(std::move(update));
            },
            [this](ag99::runtime::IncrementalOutputEvent event) {
              OnIncrementalOutputEvent(std::move(event));
            },
            [this](ag99::runtime::OutputAudioFrame frame) {
              OnIncrementalAudioFrame(std::move(frame));
            },
        }) {
    callback_lifetime_->owner = this;
    audio_worker_ = std::thread([this] {
      AudioWorkerLoop();
    });
  }

  ~Impl() {
    Close();
  }

  bool Connect(const std::string& url) {
    std::scoped_lock transport_lock(transport_mutex_);
    if (closing_.load()) {
      return false;
    }
    std::scoped_lock microphone_lock(microphone_operation_mutex_);
    const auto generation = InvalidateConnection();

    // Stop the previous capture before closing the transport so its stream
    // end marker can still be delivered when the old connection is usable.
    microphone_.Stop("runtime_reconnect");
    websocket_.close();
    ResetDisconnectedState();

    const std::weak_ptr<CallbackLifetime> weak_lifetime = callback_lifetime_;
    bool connected = websocket_.connect(
        url,
        {
            [weak_lifetime, generation](std::string text) {
              WithCallbackOwner(weak_lifetime, [&](Impl& bridge) {
                bridge.IngestText(generation, text);
              });
            },
            [weak_lifetime, generation](std::vector<std::uint8_t> binary) {
              WithCallbackOwner(weak_lifetime, [&](Impl& bridge) {
                bridge.IngestBinary(generation, binary);
              });
            },
            [](std::string error) {
              std::cerr << "[runtime] websocket error: " << error << '\n';
            },
            [weak_lifetime, generation] {
              WithCallbackOwner(weak_lifetime, [&](Impl& bridge) {
                bridge.HandleTransportClosed(generation);
              });
            },
        });
    if (connected) {
      const auto settings = ag99::runtime::build_system_desktop_runtime_settings(
          services_.native_incremental_output_enabled());
      if (!websocket_.send_text(settings.dump())) {
        websocket_.close();
        connected = false;
      }
    }
    services_.set_runtime_connected(connected);
    services_.notify_input_connection_changed();
    return connected;
  }

  bool Reconnect() {
    return Connect("ws://127.0.0.1:12396");
  }

  bool SendText(std::string_view text) {
    const auto message = services_.trim_ascii_text(std::string(text));
    if (message.empty() || !services_.runtime_connected()) {
      return false;
    }
    const auto turn_id = "native-demo-" +
        std::to_string(next_turn_id_.fetch_add(1));
    const auto envelope = ag99::runtime::build_input_text(message, {}, turn_id);
    const bool sent = websocket_.send_text(envelope.dump());
    if (sent) {
      std::scoped_lock lock(playback_mutex_);
      last_input_turn_id_ = turn_id;
      services_.set_feedback_available(false);
      services_.set_feedback_approved(false);
    }
    if (sent) {
      services_.set_status_text(L"思考中");
      services_.notify_input_runtime_state_changed();
    }
    return sent;
  }

  bool InterruptCurrentTurn() {
    std::string turn_id;
    {
      std::scoped_lock lock(playback_mutex_);
      turn_id = last_input_turn_id_;
      if (turn_id.empty()) {
        return false;
      }
    }
    const auto envelope = ag99::runtime::build_envelope(
        "control.interrupt", ag99::runtime::Json::object(), turn_id,
        "frontend");
    const bool sent = websocket_.send_text(envelope.dump());
    if (sent) {
      std::scoped_lock lock(playback_mutex_);
      last_input_turn_id_.clear();
      services_.set_status_text(L"待命");
      services_.notify_input_runtime_state_changed();
    }
    return sent;
  }

  bool ApproveLatestAssistantSegment() {
    AssistantSegment segment;
    {
      std::scoped_lock lock(playback_mutex_);
      if (!latest_assistant_segment_ || latest_assistant_segment_->approved) {
        return false;
      }
      segment = *latest_assistant_segment_;
      latest_assistant_segment_->approved = true;
    }
    const auto event_id = "native-feedback-" +
        std::to_string(next_feedback_id_.fetch_add(1));
    const auto envelope = ag99::runtime::build_envelope(
        "system.motion_lab_raw_event",
        {
            {"event_id", event_id},
            {"event_type", "motion.feedback_positive"},
            {"message_id", segment.message_id},
            {"source_route", "pet_overlay"},
            {"phase", "assistant_segment_feedback"},
            {"assistant_text", segment.text},
            {"raw", {
                {"feedback", "positive"},
                {"interaction", "overlay_thumbs_up"},
                {"turnId", segment.turn_id},
                {"messageId", segment.message_id},
            }},
        },
        segment.turn_id,
        "frontend");
    if (websocket_.send_text(envelope.dump())) {
      services_.set_feedback_approved(true);
      services_.notify_input_runtime_state_changed();
      return true;
    }
    std::scoped_lock lock(playback_mutex_);
    if (latest_assistant_segment_
        && latest_assistant_segment_->message_id == segment.message_id) {
      latest_assistant_segment_->approved = false;
    }
    return false;
  }

  bool ToggleMicrophone() {
    std::scoped_lock microphone_lock(microphone_operation_mutex_);
    if (closing_.load()) {
      return false;
    }
    if (microphone_.running()) {
      microphone_.Stop("manual_stop");
      return false;
    }
    if (!microphone_.Start()) {
      std::cerr << "[microphone] failed to start capture\n";
      return false;
    }
    return true;
  }

  bool MicrophoneRunning() const noexcept {
    return microphone_.running();
  }

  void NotifyMotionTerminal(NativeSegmentTerminal terminal) {
    CompleteMotionSegment(std::move(terminal));
  }

  void OnSegmentMotion(ag99::runtime::SegmentMotionUpdate update) {
    const auto turn_id = update.envelope.turn_id.value_or("");
    const auto message_id = update.envelope.message_id;
    NativeSegmentClock clock;
    {
      std::scoped_lock lock(playback_mutex_);
      const auto turn = playback_turns_.find(turn_id);
      if (turn == playback_turns_.end()) {
        std::cerr << "[runtime] deferred motion has no playback turn: "
                  << turn_id << '\n';
        return;
      }
      const auto segment = turn->second.segments.find(message_id);
      if (segment == turn->second.segments.end()
          || !segment->second.motion_pending
          || segment->second.motion_terminal) {
        std::cerr << "[runtime] deferred motion has no pending segment: "
                  << message_id << '\n';
        return;
      }
      if (segment->second.clock.audio_serial == 0) {
        if (update.motion.state == ag99::runtime::MotionSlot::State::Present) {
          segment->second.deferred_motion = std::move(update.motion);
          return;
        }
        segment->second.motion_pending = false;
      } else {
        segment->second.motion_pending = false;
      }
      clock = segment->second.clock;
    }
    ApplyMotionUpdate(turn_id, message_id, clock, std::move(update.motion));
  }

  void Close() {
    std::unique_lock transport_lock(transport_mutex_);
    const bool was_closing = closing_.exchange(true);
    if (!was_closing) {
      {
        std::scoped_lock lifetime_lock(callback_lifetime_->mutex);
        callback_lifetime_->owner = nullptr;
      }
      InvalidateConnection();
      std::scoped_lock microphone_lock(microphone_operation_mutex_);
      microphone_.Stop("runtime_shutdown");
      websocket_.close();
      ResetDisconnectedState();
    }
    services_.set_runtime_connected(false);
    services_.notify_input_connection_changed();
    services_.audio_queue->audio_queue_condition.notify_all();
    transport_lock.unlock();
    {
      std::scoped_lock join_lock(services_.audio_queue->audio_join_mutex);
      if (audio_worker_.joinable()) {
        audio_worker_.join();
      }
    }
    if (!was_closing) {
      services_.stop_current_audio(std::nullopt);
      services_.stop_incremental_audio();
    }
  }

private:
  static constexpr std::size_t kIncrementalAudioWindowBytes = 128 * 1024;
  static constexpr std::size_t kIncrementalAudioWindowFrames = 64;
  static constexpr std::size_t kMaxIncrementalAudioJobs = 64 + 256;

  template <typename Callback>
  static void WithCallbackOwner(
      const std::weak_ptr<CallbackLifetime>& weak_lifetime,
      Callback&& callback) {
    const auto lifetime = weak_lifetime.lock();
    if (!lifetime) {
      return;
    }
    std::scoped_lock lock(lifetime->mutex);
    if (lifetime->owner) {
      callback(*lifetime->owner);
    }
  }

  void IngestText(std::uint64_t generation, std::string_view text) {
    {
      std::scoped_lock lock(session_mutex_);
      if (generation == connection_generation_.load() && !closing_.load()) {
        session_.ingest_text(text);
      }
    }
    FlushReadyPlaybackAcknowledgements();
  }

  void BeginTurn(const std::string& turn_id) {
    std::scoped_lock lock(playback_mutex_);
    playback_turns_[turn_id] = TurnPlaybackState{
        .generation = connection_generation_.load()};
  }

  void MarkSynthesisFinished(const std::string& turn_id) {
    std::scoped_lock lock(playback_mutex_);
    const auto it = playback_turns_.find(turn_id);
    if (it == playback_turns_.end()
        || it->second.generation != connection_generation_.load()) {
      std::cerr << "[runtime] synth_finished for unknown turn: "
                << turn_id << '\n';
      return;
    }
    it->second.synth_finished = true;
  }

  IncrementalSegmentPlaybackState* FindIncrementalSegmentLocked(
      const ag99::runtime::IncrementalIdentity& identity,
      TurnPlaybackState& turn) {
    const auto segment = turn.incremental_segments.find(
        identity.segment_message_id);
    if (segment == turn.incremental_segments.end()) {
      return nullptr;
    }
    return &segment->second;
  }

  IncrementalSegmentPlaybackState* EnsureIncrementalSegmentLocked(
      const ag99::runtime::IncrementalIdentity& identity,
      TurnPlaybackState& turn) {
    auto [segment, inserted] = turn.incremental_segments.try_emplace(
        identity.segment_message_id);
    if (inserted) {
      segment->second.sequence = static_cast<std::int64_t>(
          identity.segment_index);
      segment->second.clock.turn_id = identity.turn_id;
      segment->second.clock.message_id = identity.segment_message_id;
      segment->second.clock.sequence = segment->second.sequence;
      segment->second.clock.generation = turn.generation;
    }
    return &segment->second;
  }

  static std::string IncrementalSegmentFailureReason(
      const IncrementalSegmentPlaybackState& segment) {
    if (!segment.text_failure_reason.empty()) {
      return segment.text_failure_reason;
    }
    if (!segment.audio_failure_reason.empty()) {
      return segment.audio_failure_reason;
    }
    return segment.motion_failure_reason;
  }

  static std::string ResolveFailureReason(
      std::string_view reason,
      std::string_view fallback) {
    return reason.empty() ? std::string(fallback) : std::string(reason);
  }

  static std::string SegmentFailureReason(
      const SegmentPlaybackState& segment) {
    if (!segment.text_failure_reason.empty()) {
      return segment.text_failure_reason;
    }
    if (!segment.audio_failure_reason.empty()) {
      return segment.audio_failure_reason;
    }
    return segment.motion_failure_reason;
  }

  bool RegisterSegment(
      const ag99::runtime::OutputSegment& output,
      std::uint64_t generation,
      const NativeSegmentClock& clock) {
    const auto turn_id = output.envelope.turn_id.value_or("");
    std::scoped_lock lock(playback_mutex_);
    const auto turn = playback_turns_.find(turn_id);
    if (turn == playback_turns_.end()
        || turn->second.generation != generation
        || turn->second.synth_finished) {
      std::cerr << "[runtime] output segment has no open playback turn: "
                << turn_id << '\n';
      return false;
    }
    SegmentPlaybackState segment;
    segment.sequence = output.sequence;
    segment.clock = clock;
    segment.audio_terminal =
        output.audio.state != ag99::runtime::AudioSlot::State::Present;
    segment.motion_terminal =
        output.motion.state != ag99::runtime::MotionSlot::State::Present
        && output.motion.state != ag99::runtime::MotionSlot::State::Pending;
    segment.motion_pending =
        output.motion.state == ag99::runtime::MotionSlot::State::Pending;
    if (output.text.state == ag99::runtime::TextSlot::State::Failed) {
      segment.text_failure_reason = ResolveFailureReason(
          output.text.reason,
          "text_playback_failed:" + output.envelope.message_id);
    }
    if (output.audio.state == ag99::runtime::AudioSlot::State::Failed) {
      segment.audio_failure_reason = ResolveFailureReason(
          output.audio.reason,
          "audio_playback_failed:" + output.envelope.message_id);
    }
    if (output.motion.state == ag99::runtime::MotionSlot::State::Failed) {
      segment.motion_failure_reason = ResolveFailureReason(
          output.motion.reason,
          "motion_playback_failed:" + output.envelope.message_id);
    }
    const auto [_, inserted] = turn->second.segments.emplace(
        output.envelope.message_id, std::move(segment));
    if (!inserted) {
      std::cerr << "[runtime] duplicate playback segment state: "
                << output.envelope.message_id << '\n';
      return false;
    }
    return true;
  }

  bool IsSegmentPlaybackOpen(const AudioQueueItem& item) {
    std::scoped_lock lock(playback_mutex_);
    const auto turn = playback_turns_.find(item.turn_id);
    return turn != playback_turns_.end()
        && turn->second.generation == item.generation
        && turn->second.segments.contains(item.message_id);
  }

  void CompleteAudioSegment(
      const AudioQueueItem& item,
      bool success,
      std::string_view reason = {}) {
    {
      std::scoped_lock lock(playback_mutex_);
      const auto turn = playback_turns_.find(item.turn_id);
      if (turn == playback_turns_.end()
          || turn->second.generation != item.generation) {
        return;
      }
      const auto segment = turn->second.segments.find(item.message_id);
      if (segment == turn->second.segments.end()
          || segment->second.audio_terminal) {
        return;
      }
      segment->second.audio_terminal = true;
      if (!success) {
        segment->second.audio_failure_reason = ResolveFailureReason(
            reason,
            "audio_playback_failed:" + item.message_id);
        if (!segment->second.motion_terminal) {
          segment->second.motion_terminal = true;
          segment->second.motion_failure_reason =
              "motion_not_started_after_audio_failure";
        }
      }
    }
    QueuePlaybackAcknowledgement(item.turn_id);
  }

  void CompleteMotionSegment(NativeSegmentTerminal terminal) {
    {
      std::scoped_lock lock(playback_mutex_);
      const auto turn = playback_turns_.find(terminal.clock.turn_id);
      if (turn == playback_turns_.end()
          || turn->second.generation != terminal.clock.generation) {
        return;
      }
      const auto segment = turn->second.segments.find(
          terminal.clock.message_id);
      if (segment != turn->second.segments.end()) {
        if (segment->second.motion_terminal) {
          return;
        }
        segment->second.motion_terminal = true;
        if (!terminal.success) {
          segment->second.motion_failure_reason = ResolveFailureReason(
              terminal.reason,
              "motion_playback_failed:" + terminal.clock.message_id);
        }
        if (terminal.success && terminal.reason != "deferred_motion_absent"
            && latest_assistant_segment_
            && latest_assistant_segment_->message_id
                == terminal.clock.message_id) {
          services_.set_feedback_available(true);
          services_.set_status_text(L"待命");
          services_.notify_input_runtime_state_changed();
        }
      } else {
        const auto incremental_segment = turn->second.incremental_segments.find(
            terminal.clock.message_id);
        if (incremental_segment == turn->second.incremental_segments.end()
            || incremental_segment->second.motion_terminal
            || !incremental_segment->second.motion_dispatched) {
          return;
        }
        incremental_segment->second.motion_terminal = true;
        if (!terminal.success && terminal.reason != "motion_plan_replaced") {
          incremental_segment->second.motion_failure_reason =
              ResolveFailureReason(
                  terminal.reason,
                  "incremental_motion_playback_failed:" +
                      terminal.clock.message_id);
        } else if (latest_assistant_segment_
            && latest_assistant_segment_->message_id
                == terminal.clock.message_id) {
          services_.set_feedback_available(true);
          services_.set_status_text(L"待命");
          services_.notify_input_runtime_state_changed();
        }
      }
    }
    QueuePlaybackAcknowledgement(terminal.clock.turn_id);
  }

  void DispatchMotionUpdate(
      const std::string& turn_id,
      const std::string& message_id,
      const NativeSegmentClock& clock,
      ag99::runtime::MotionSlot motion) {
    ag99::runtime::OutputSegment segment;
    segment.envelope.turn_id = turn_id;
    segment.envelope.message_id = message_id;
    segment.schema_version = std::string(ag99::runtime::kOutputSegmentSchema);
    segment.sequence = clock.sequence;
    segment.motion = std::move(motion);
    if (on_output_segment_) {
      on_output_segment_(std::move(segment), clock);
    } else {
      CompleteMotionSegment(NativeSegmentTerminal{
          clock, false, "motion_sink_unavailable"});
    }
  }

  void ApplyMotionUpdate(
      const std::string& turn_id,
      const std::string& message_id,
      const NativeSegmentClock& clock,
      ag99::runtime::MotionSlot motion) {
    if (motion.state == ag99::runtime::MotionSlot::State::Absent) {
      CompleteMotionSegment(NativeSegmentTerminal{
          clock, true, "deferred_motion_absent"});
      return;
    }
    if (motion.state == ag99::runtime::MotionSlot::State::Failed) {
      CompleteMotionSegment(NativeSegmentTerminal{
          clock,
          false,
          motion.reason.empty()
              ? "deferred_motion_failed"
              : motion.reason});
      return;
    }
    if (clock.audio_serial == 0
        || services_.audio_serial->load() != clock.audio_serial
        || services_.now_seconds() >= clock.started_at_seconds + clock.duration_seconds) {
      CompleteMotionSegment(NativeSegmentTerminal{
          clock, false, "deferred_motion_audio_window_unavailable"});
      return;
    }
    DispatchMotionUpdate(turn_id, message_id, clock, std::move(motion));
  }

  std::optional<ag99::runtime::MotionSlot> ActivateAudioSegment(
      const AudioQueueItem& item,
      const NativeSegmentClock& clock) {
    std::scoped_lock lock(playback_mutex_);
    const auto turn = playback_turns_.find(item.turn_id);
    if (turn == playback_turns_.end()
        || turn->second.generation != item.generation) {
      return std::nullopt;
    }
    const auto segment = turn->second.segments.find(item.message_id);
    if (segment == turn->second.segments.end()) {
      return std::nullopt;
    }
    segment->second.clock = clock;
    if (!segment->second.deferred_motion) {
      return std::nullopt;
    }
    segment->second.motion_pending = false;
    auto deferred = std::move(segment->second.deferred_motion);
    segment->second.deferred_motion.reset();
    return deferred;
  }

  void MaybeDispatchIncrementalMotion(
      const ag99::runtime::IncrementalIdentity& identity) {
    ag99::runtime::OutputSegment segment;
    NativeSegmentClock clock;
    bool dispatch = false;
    bool settled_without_motion = false;
    {
      std::scoped_lock lock(playback_mutex_);
      const auto turn = playback_turns_.find(identity.turn_id);
      if (turn == playback_turns_.end()) {
        return;
      }
      auto* incremental_segment = FindIncrementalSegmentLocked(
          identity, turn->second);
      if (!incremental_segment
          || turn->second.generation != connection_generation_.load()
          || !incremental_segment->audio_terminal
          || !incremental_segment->motion_stream_terminal
          || incremental_segment->motion_terminal
          || incremental_segment->motion_dispatched) {
        return;
      }
      if (incremental_segment->latest_motion.state
          != ag99::runtime::MotionSlot::State::Present) {
        incremental_segment->motion_terminal = true;
        settled_without_motion = true;
      } else {
        const auto audio_end_seconds = incremental_segment->clock
            .started_at_seconds + incremental_segment->clock.duration_seconds;
        const auto late_seconds = incremental_segment->motion_received_at_seconds
            > 0.0
            ? std::max(
                0.0,
                incremental_segment->motion_received_at_seconds
                    - audio_end_seconds)
            : 0.0;
        if (late_seconds > kMaxIncrementalMotionLateTailSeconds) {
          incremental_segment->motion_terminal = true;
          incremental_segment->motion_failure_reason =
              "incremental_motion_late_tail_expired:" +
              std::to_string(static_cast<long long>(std::lround(
                  late_seconds * 1000.0)));
          settled_without_motion = true;
        } else {
          incremental_segment->motion_dispatched = true;
          clock = incremental_segment->clock;
          // OLV motion is released after PCM has reached its terminal state. It
          // therefore owns a fresh motion-only clock instead of reusing an
          // expired audio window.
          clock.started_at_seconds = services_.now_seconds();
          clock.duration_seconds = 0.0;
          clock.audio_serial = 0;
          segment.envelope.turn_id = identity.turn_id;
          segment.envelope.message_id = identity.segment_message_id;
          segment.schema_version = std::string(ag99::runtime::kOutputSegmentSchema);
          segment.sequence = incremental_segment->sequence;
          segment.motion = incremental_segment->latest_motion;
          dispatch = true;
        }
      }
    }
    if (settled_without_motion) {
      QueuePlaybackAcknowledgement(identity.turn_id);
      return;
    }
    if (!dispatch) {
      return;
    }
    if (on_output_segment_) {
      on_output_segment_(std::move(segment), std::move(clock));
    } else {
      CompleteMotionSegment(NativeSegmentTerminal{
          std::move(clock), false, "motion_sink_unavailable"});
    }
  }

  void CompleteIncrementalAudio(
      const ag99::runtime::IncrementalIdentity& identity,
      NativeSegmentClock clock,
      bool success,
      std::string_view reason = {}) {
    bool dispatch_motion = false;
    {
      std::scoped_lock lock(playback_mutex_);
      const auto turn = playback_turns_.find(identity.turn_id);
      if (turn == playback_turns_.end()
          || turn->second.generation != connection_generation_.load()) {
        return;
      }
      auto* incremental_segment = FindIncrementalSegmentLocked(
          identity, turn->second);
      if (!incremental_segment || incremental_segment->audio_terminal) {
        return;
      }
      incremental_segment->audio_terminal = true;
      incremental_segment->clock = clock;
      if (!success) {
        incremental_segment->audio_failure_reason = ResolveFailureReason(
            reason,
            "incremental_audio_playback_failed");
        if (!incremental_segment->motion_terminal) {
          incremental_segment->motion_terminal = true;
          incremental_segment->motion_failure_reason =
              "incremental_motion_not_started_after_audio_failure";
        }
      } else {
        dispatch_motion = true;
      }
    }
    if (dispatch_motion) {
      MaybeDispatchIncrementalMotion(identity);
    }
    QueuePlaybackAcknowledgement(identity.turn_id);
  }

  void RetireTurn(const std::string& turn_id, bool cancel_playback) {
    {
      std::scoped_lock lock(playback_mutex_);
      playback_turns_.erase(turn_id);
      if (last_input_turn_id_ == turn_id) {
        last_input_turn_id_.clear();
      }
    }
    if (cancel_playback) {
      std::optional<std::uint64_t> audio_serial_to_stop;
      {
        std::scoped_lock lock(services_.audio_queue->audio_queue_mutex);
        for (auto it = services_.audio_queue->audio_queue.begin(); it != services_.audio_queue->audio_queue.end();) {
          if (it->turn_id == turn_id) {
            it = services_.audio_queue->audio_queue.erase(it);
          } else {
            ++it;
          }
        }
        for (auto it = services_.audio_queue->incremental_audio_queue.begin();
             it != services_.audio_queue->incremental_audio_queue.end();) {
          if (it->identity.turn_id == turn_id) {
            if (it->kind == IncrementalAudioJob::Kind::Frame) {
              services_.audio_queue->incremental_audio_queued_bytes -= it->frame.pcm.size();
              services_.audio_queue->incremental_audio_queued_frames -= 1;
            }
            it = services_.audio_queue->incremental_audio_queue.erase(it);
          } else {
            ++it;
          }
        }
        services_.audio_queue->playback_ack_queue.erase(
            std::remove_if(
                services_.audio_queue->playback_ack_queue.begin(),
                services_.audio_queue->playback_ack_queue.end(),
                [&turn_id](const PlaybackAcknowledgementItem& item) {
                  return item.turn_id == turn_id;
                }),
            services_.audio_queue->playback_ack_queue.end());
        if (services_.audio_queue->current_audio_turn_id == turn_id) {
          audio_serial_to_stop = services_.audio_queue->current_audio_serial;
          services_.audio_queue->current_audio_turn_id.clear();
          services_.audio_queue->current_audio_message_id.clear();
          services_.audio_queue->current_audio_generation = 0;
          services_.audio_queue->current_audio_serial = 0;
        }
      }
      if (audio_serial_to_stop) {
        services_.stop_current_audio(*audio_serial_to_stop);
      }
      services_.stop_incremental_audio();
      services_.audio_queue->audio_queue_condition.notify_one();
    }
  }

  void ClearCurrentAudio(
      const AudioQueueItem& item,
      std::uint64_t audio_serial) {
    std::scoped_lock lock(services_.audio_queue->audio_queue_mutex);
    if (services_.audio_queue->current_audio_turn_id == item.turn_id
        && services_.audio_queue->current_audio_message_id == item.message_id
        && services_.audio_queue->current_audio_generation == item.generation
        && services_.audio_queue->current_audio_serial == audio_serial) {
      services_.audio_queue->current_audio_turn_id.clear();
      services_.audio_queue->current_audio_message_id.clear();
      services_.audio_queue->current_audio_generation = 0;
      services_.audio_queue->current_audio_serial = 0;
    }
  }

  void QueuePlaybackAcknowledgement(const std::string& turn_id) {
    std::uint64_t generation = 0;
    {
      std::scoped_lock lock(playback_mutex_);
      const auto turn = playback_turns_.find(turn_id);
      if (turn == playback_turns_.end()
          || !turn->second.synth_finished
          || turn->second.acknowledgement_queued
          || turn->second.acknowledgement_claimed) {
        return;
      }
      turn->second.acknowledgement_queued = true;
      generation = turn->second.generation;
    }
    {
      std::scoped_lock lock(services_.audio_queue->audio_queue_mutex);
      services_.audio_queue->playback_ack_queue.push_back(
          PlaybackAcknowledgementItem{turn_id, generation});
    }
    services_.audio_queue->audio_queue_condition.notify_one();
  }

  void FlushReadyPlaybackAcknowledgements() {
    std::vector<std::string> candidates;
    {
      std::scoped_lock lock(playback_mutex_);
      for (const auto& [turn_id, turn] : playback_turns_) {
        if (turn.synth_finished
            && turn.generation == connection_generation_.load()) {
          candidates.push_back(turn_id);
        }
      }
    }
    for (const auto& turn_id : candidates) {
      QueuePlaybackAcknowledgement(turn_id);
    }
  }

  void TrySendPlaybackAcknowledgement(
      const std::string& turn_id,
      std::uint64_t queued_generation) {
    bool success = true;
    std::string failure_reason;
    std::uint64_t generation = 0;
    {
      std::scoped_lock lock(playback_mutex_);
      const auto turn = playback_turns_.find(turn_id);
      if (turn != playback_turns_.end()
          && turn->second.generation == queued_generation) {
        turn->second.acknowledgement_queued = false;
      }
      if (turn == playback_turns_.end()
          || turn->second.generation != queued_generation
          || !turn->second.synth_finished
          || turn->second.acknowledgement_claimed
          || (turn->second.segments.empty()
              && turn->second.incremental_segments.empty())) {
        return;
      }
      std::vector<const SegmentPlaybackState*> ordered_segments;
      ordered_segments.reserve(turn->second.segments.size());
      for (const auto& [_, segment] : turn->second.segments) {
        if (!segment.audio_terminal || !segment.motion_terminal) {
          return;
        }
        ordered_segments.push_back(&segment);
      }
      std::sort(
          ordered_segments.begin(), ordered_segments.end(),
          [](const auto* left, const auto* right) {
            return left->sequence < right->sequence;
          });
      for (const auto* segment : ordered_segments) {
        const auto segment_failure_reason = SegmentFailureReason(*segment);
        if (!segment_failure_reason.empty()) {
          success = false;
          failure_reason = segment_failure_reason;
          break;
        }
      }
      for (const auto& [_, segment] : turn->second.incremental_segments) {
        if (!segment.text_terminal || !segment.audio_terminal
            || !segment.motion_terminal) {
          return;
        }
        if (success) {
          const auto segment_failure_reason =
              IncrementalSegmentFailureReason(segment);
          if (!segment_failure_reason.empty()) {
            success = false;
            failure_reason = segment_failure_reason;
            break;
          }
        }
      }
      generation = turn->second.generation;
      turn->second.acknowledgement_claimed = true;
    }

    const auto send_result = SendPlaybackFinished(
        turn_id,
        generation,
        success,
        failure_reason.empty()
            ? std::nullopt
            : std::optional<std::string_view>(failure_reason));
    if (send_result == PlaybackAckSendResult::Failed) {
      std::cerr << "[runtime] failed to send playback completion for turn: "
                << turn_id << '\n';
    }
  }

  void IngestBinary(
      std::uint64_t generation,
      const std::vector<std::uint8_t>& binary) {
    std::scoped_lock lock(session_mutex_);
    if (generation == connection_generation_.load() && !closing_.load()) {
      session_.ingest_binary(binary);
    }
  }

  void OnIncrementalOutputEvent(ag99::runtime::IncrementalOutputEvent event) {
    if (!services_.native_incremental_output_enabled()) {
      return;
    }
    const auto& identity = event.identity;
    if (event.resource == ag99::runtime::IncrementalOutputResource::Text) {
      if (event.kind == ag99::runtime::IncrementalOutputEventKind::Start) {
        std::scoped_lock lock(playback_mutex_);
        const auto turn = playback_turns_.find(identity.turn_id);
        if (turn != playback_turns_.end() && !turn->second.synth_finished) {
          turn->second.incremental_text[identity.segment_message_id].clear();
          if (auto* segment = EnsureIncrementalSegmentLocked(
                  identity, turn->second)) {
            segment->text_terminal = false;
          }
        }
      } else if (event.kind
          == ag99::runtime::IncrementalOutputEventKind::TextDelta) {
        std::string text;
        {
          std::scoped_lock lock(playback_mutex_);
          const auto turn = playback_turns_.find(identity.turn_id);
          if (turn == playback_turns_.end() || turn->second.synth_finished) {
            return;
          }
          auto& accumulated = turn->second.incremental_text[
              identity.segment_message_id];
          accumulated += event.text;
          text = accumulated;
          auto* segment = EnsureIncrementalSegmentLocked(
              identity, turn->second);
          if (!segment) {
            return;
          }
          segment->text_terminal = false;
          latest_assistant_segment_ = AssistantSegment{
              identity.turn_id,
              identity.segment_message_id,
              text,
              false};
        }
        std::cout << "[assistant] " << text << '\n';
        services_.set_preview_text(services_.widen_utf8(text));
        services_.set_feedback_available(false);
        services_.set_feedback_approved(false);
        services_.set_status_text(L"播放中");
        services_.notify_input_runtime_state_changed();
      } else if (event.kind
          == ag99::runtime::IncrementalOutputEventKind::End) {
        {
          std::scoped_lock lock(playback_mutex_);
          const auto turn = playback_turns_.find(identity.turn_id);
          if (turn == playback_turns_.end() || turn->second.synth_finished) {
            return;
          }
          auto* segment = EnsureIncrementalSegmentLocked(
              identity, turn->second);
          if (!segment) {
            return;
          }
          segment->text_terminal = true;
          if (event.status != ag99::runtime::IncrementalOutputStatus::Completed) {
            segment->text_failure_reason = ResolveFailureReason(
                event.reason,
                "incremental_text_stream_failed");
          }
        }
        QueuePlaybackAcknowledgement(identity.turn_id);
      }
      return;
    }

    if (event.resource == ag99::runtime::IncrementalOutputResource::Motion) {
      if (event.kind == ag99::runtime::IncrementalOutputEventKind::Start) {
        std::scoped_lock lock(playback_mutex_);
        const auto turn = playback_turns_.find(identity.turn_id);
        if (turn != playback_turns_.end() && !turn->second.synth_finished) {
          auto* segment = EnsureIncrementalSegmentLocked(
              identity, turn->second);
          if (segment) {
            segment->motion_stream_terminal = false;
            segment->motion_terminal = false;
            segment->motion_dispatched = false;
            segment->latest_motion = {};
          }
        }
      } else if (event.kind
          == ag99::runtime::IncrementalOutputEventKind::MotionUpdate) {
        std::scoped_lock lock(playback_mutex_);
        const auto turn = playback_turns_.find(identity.turn_id);
        if (turn == playback_turns_.end() || turn->second.synth_finished) {
          return;
        }
        auto* segment = EnsureIncrementalSegmentLocked(
            identity, turn->second);
        if (!segment) {
          return;
        }
        segment->latest_motion.state = ag99::runtime::MotionSlot::State::Present;
        segment->latest_motion.message_type = "output.motion_stream_update";
        segment->latest_motion.mode = "stream";
        segment->latest_motion.source = "incremental_stream";
        segment->latest_motion.payload = std::move(event.motion_payload);
        segment->motion_received_at_seconds = services_.now_seconds();
        segment->motion_terminal = false;
        segment->motion_dispatched = false;
      } else if (event.kind
          == ag99::runtime::IncrementalOutputEventKind::End) {
        {
          std::scoped_lock lock(playback_mutex_);
          const auto turn = playback_turns_.find(identity.turn_id);
          if (turn == playback_turns_.end() || turn->second.synth_finished) {
            return;
          }
          auto* segment = EnsureIncrementalSegmentLocked(
              identity, turn->second);
          if (!segment) {
            return;
          }
          segment->motion_stream_terminal = true;
          if (event.status != ag99::runtime::IncrementalOutputStatus::Completed) {
            segment->motion_terminal = true;
            segment->motion_failure_reason = ResolveFailureReason(
                event.reason,
                "incremental_motion_stream_failed");
          }
        }
        if (event.status
            == ag99::runtime::IncrementalOutputStatus::Completed) {
          MaybeDispatchIncrementalMotion(identity);
        }
        QueuePlaybackAcknowledgement(identity.turn_id);
      }
      return;
    }

    if (event.resource != ag99::runtime::IncrementalOutputResource::Audio
        || (event.kind != ag99::runtime::IncrementalOutputEventKind::Start
            && event.kind != ag99::runtime::IncrementalOutputEventKind::End)
        || (event.kind == ag99::runtime::IncrementalOutputEventKind::End
            && !event.length.has_value())) {
      return;
    }
    if (event.kind == ag99::runtime::IncrementalOutputEventKind::Start) {
      std::scoped_lock lock(playback_mutex_);
      const auto turn = playback_turns_.find(identity.turn_id);
      if (turn != playback_turns_.end() && !turn->second.synth_finished) {
        if (auto* segment = EnsureIncrementalSegmentLocked(
                identity, turn->second)) {
          segment->audio_terminal = false;
        }
      }
      return;
    }
    IncrementalAudioJob job;
    job.kind = IncrementalAudioJob::Kind::End;
    job.identity = event.identity;
    job.total_samples = *event.length;
    job.status = event.status;
    job.reason = std::move(event.reason);
    job.generation = connection_generation_.load();
    bool rejected = false;
    {
      std::scoped_lock lock(services_.audio_queue->audio_queue_mutex);
      if (closing_.load()
          || services_.audio_queue->incremental_audio_queue.size() >= kMaxIncrementalAudioJobs) {
        std::cerr << "[runtime] incremental audio job capacity exceeded\n";
        rejected = true;
      } else {
        services_.audio_queue->incremental_audio_queue.push_back(std::move(job));
      }
    }
    if (rejected) {
      FailIncrementalAudio(event.identity, "incremental_audio_job_capacity_exceeded");
      return;
    }
    services_.audio_queue->audio_queue_condition.notify_one();
  }

  void OnIncrementalAudioFrame(ag99::runtime::OutputAudioFrame frame) {
    if (!services_.native_incremental_output_enabled()) {
      return;
    }
    {
      std::scoped_lock lock(playback_mutex_);
      const auto turn = playback_turns_.find(frame.identity.turn_id);
      if (turn == playback_turns_.end() || turn->second.synth_finished) {
        return;
      }
      if (!EnsureIncrementalSegmentLocked(frame.identity, turn->second)) {
        return;
      }
    }
    IncrementalAudioJob job;
    job.kind = IncrementalAudioJob::Kind::Frame;
    job.identity = frame.identity;
    job.frame = std::move(frame);
    job.generation = connection_generation_.load();
    bool rejected = false;
    {
      std::scoped_lock lock(services_.audio_queue->audio_queue_mutex);
      const auto next_bytes = services_.audio_queue->incremental_audio_queued_bytes
          + job.frame.pcm.size();
      const auto next_frames = services_.audio_queue->incremental_audio_queued_frames + 1;
      if (closing_.load() || next_bytes > kIncrementalAudioWindowBytes
          || next_frames > kIncrementalAudioWindowFrames
          || services_.audio_queue->incremental_audio_queue.size() >= kMaxIncrementalAudioJobs) {
        std::cerr << "[runtime] incremental audio admission window exceeded\n";
        rejected = true;
      } else {
        services_.audio_queue->incremental_audio_queued_bytes = next_bytes;
        services_.audio_queue->incremental_audio_queued_frames = next_frames;
        services_.audio_queue->incremental_audio_queue.push_back(std::move(job));
      }
    }
    if (rejected) {
      FailIncrementalAudio(
          job.identity, "incremental_audio_credit_window_exceeded");
      return;
    }
    services_.audio_queue->audio_queue_condition.notify_one();
  }

  void FailIncrementalAudio(
      const ag99::runtime::IncrementalIdentity& identity,
      std::string_view reason) {
    {
      std::scoped_lock lock(playback_mutex_);
      if (!playback_turns_.contains(identity.turn_id)) {
        return;
      }
    }
    const auto interrupt = ag99::runtime::build_envelope(
        "control.interrupt",
        ag99::runtime::Json::object(),
        identity.turn_id,
        "frontend");
    {
      std::scoped_lock transport_lock(transport_mutex_);
      if (!closing_.load() && !websocket_.send_text(interrupt.dump())) {
        std::cerr << "[runtime] failed to interrupt incremental audio turn: "
                  << identity.turn_id << '\n';
      }
    }
    std::cerr << "[runtime] incremental audio failed: " << reason << '\n';
    RetireTurn(identity.turn_id, true);
    if (on_turn_interrupted_) {
      on_turn_interrupted_(identity.turn_id);
    }
  }

  std::uint64_t InvalidateConnection() {
    std::scoped_lock lock(session_mutex_);
    const auto generation = connection_generation_.fetch_add(1) + 1;
    session_.reset();
    return generation;
  }

  void ResetDisconnectedState() {
    if (on_turn_finished_) {
      on_turn_finished_("", true, "");
    }
    {
      std::scoped_lock lock(playback_mutex_);
      playback_turns_.clear();
      last_input_turn_id_.clear();
      latest_assistant_segment_.reset();
    }
    services_.reset_input_disconnected();
    services_.notify_input_runtime_state_changed();
    {
      std::scoped_lock lock(services_.audio_queue->audio_queue_mutex);
      services_.audio_queue->audio_queue.clear();
      services_.audio_queue->incremental_audio_queue.clear();
      services_.audio_queue->incremental_audio_queued_bytes = 0;
      services_.audio_queue->incremental_audio_queued_frames = 0;
      services_.audio_queue->playback_ack_queue.clear();
      services_.audio_queue->current_audio_turn_id.clear();
      services_.audio_queue->current_audio_message_id.clear();
      services_.audio_queue->current_audio_generation = 0;
      services_.audio_queue->current_audio_serial = 0;
    }
    services_.stop_current_audio(std::nullopt);
    services_.stop_incremental_audio();
    if (on_output_segment_reset_) {
      on_output_segment_reset_(connection_generation_.load());
    }
  }

  void HandleTransportClosed(std::uint64_t generation) {
    if (closing_.load() || generation != connection_generation_.load()) {
      return;
    }
    std::cerr << "[runtime] websocket closed\n";
    services_.set_runtime_connected(false);
    services_.set_status_text(L"离线");
    services_.notify_input_runtime_state_changed();
    services_.notify_input_connection_changed();
    pending_closed_generation_.store(generation);
    services_.stop_current_audio(std::nullopt);
    services_.stop_incremental_audio();
    services_.audio_queue->audio_queue_condition.notify_all();
  }

  void ProcessPendingTransportClosed() {
    const auto generation = pending_closed_generation_.exchange(0);
    if (generation == 0) {
      return;
    }
    std::scoped_lock transport_lock(transport_mutex_);
    if (closing_.load() || generation != connection_generation_.load()) {
      return;
    }
    InvalidateConnection();
    std::scoped_lock microphone_lock(microphone_operation_mutex_);
    microphone_.Stop("websocket_closed");
    websocket_.close();
    ResetDisconnectedState();
  }

  void OnSegment(ag99::runtime::OutputSegment segment) {
    if (closing_.load()) {
      return;
    }
    auto turn_id = segment.envelope.turn_id.value_or("");
    if (segment.text.state == ag99::runtime::TextSlot::State::Present) {
      std::cout << "[assistant] " << segment.text.content << '\n';
      std::scoped_lock lock(playback_mutex_);
      latest_assistant_segment_ = AssistantSegment{
          turn_id,
          segment.envelope.message_id,
          segment.text.content,
          false};
      services_.set_preview_text(std::wstring(
          segment.text.content.begin(), segment.text.content.end()));
      services_.set_feedback_available(false);
      services_.set_feedback_approved(false);
      services_.set_status_text(L"播放中");
      services_.notify_input_runtime_state_changed();
    }
    const auto generation = connection_generation_.load();
    NativeSegmentClock clock;
    clock.turn_id = turn_id;
    clock.message_id = segment.envelope.message_id;
    clock.sequence = segment.sequence;
    clock.started_at_seconds = services_.now_seconds();
    clock.generation = generation;
    if (!RegisterSegment(segment, generation, clock)) {
      return;
    }

    if (segment.audio.state == ag99::runtime::AudioSlot::State::Present) {
      AudioQueueItem item;
      item.segment = std::move(segment);
      item.turn_id = turn_id;
      item.message_id = item.segment.envelope.message_id;
      item.sequence = item.segment.sequence;
      item.generation = generation;
      {
        std::scoped_lock lock(services_.audio_queue->audio_queue_mutex);
        if (closing_.load()) {
          return;
        }
        services_.audio_queue->audio_queue.push_back(std::move(item));
      }
      services_.audio_queue->audio_queue_condition.notify_one();
      return;
    }

    if (segment.motion.state == ag99::runtime::MotionSlot::State::Present
        && segment.audio.state == ag99::runtime::AudioSlot::State::Absent) {
      if (on_output_segment_) {
        on_output_segment_(std::move(segment), clock);
      } else {
        CompleteMotionSegment(NativeSegmentTerminal{
            std::move(clock), false, "motion_sink_unavailable"});
      }
    } else if (segment.motion.state
                   == ag99::runtime::MotionSlot::State::Present
               && segment.audio.state
                   == ag99::runtime::AudioSlot::State::Failed) {
      CompleteMotionSegment(NativeSegmentTerminal{
          std::move(clock),
          false,
          segment.audio.reason.empty()
              ? "audio_payload_failed"
              : segment.audio.reason});
    }
  }

  bool SendIncrementalAudioCredit(
      const ag99::runtime::OutputAudioFrame& frame,
      std::uint64_t released_bytes,
      std::uint64_t released_frames) {
    std::scoped_lock transport_lock(transport_mutex_);
    if (closing_.load() || frame.identity.turn_id.empty()
        || connection_generation_.load() == 0) {
      return false;
    }
    const auto credit = ag99::runtime::build_control_audio_credit(
        frame.identity.turn_id,
        {.core_turn_id = frame.identity.core_turn_id,
         .persona_result_id = frame.identity.persona_result_id,
         .released_bytes = released_bytes,
         .released_frames = released_frames});
    return websocket_.send_text(credit.dump());
  }

  void UpdateIncrementalAudioSignal(
      std::span<const std::uint8_t> pcm,
      std::uint32_t sample_rate,
      std::uint32_t channels,
      IncrementalWorkerState& state) {
    if (channels != 1 || sample_rate == 0 || pcm.size() % 2 != 0) {
      return;
    }
    if (!state.audio_clock_started) {
      state.audio_clock_started = true;
      state.sample_rate = sample_rate;
      state.audio_start_seconds = services_.now_seconds();
      state.audio_serial = services_.audio_serial->fetch_add(1) + 1;
      services_.audio_start_seconds->store(state.audio_start_seconds);
      services_.audio_end_seconds->store(state.audio_start_seconds);
      {
        std::scoped_lock signal_lock((*services_.audio_signal_mutex));
        services_.audio_rms->clear();
      }
    }
    const auto* samples = reinterpret_cast<const std::int16_t*>(pcm.data());
    const auto sample_count = pcm.size() / sizeof(std::int16_t);
    const auto samples_per_bucket = std::max<std::size_t>(1, sample_rate / 50);
    for (std::size_t index = 0; index < sample_count; ++index) {
      const auto normalized = static_cast<double>(samples[index]) / 32768.0;
      state.rms_sum += normalized * normalized;
      ++state.rms_samples;
      if (state.rms_samples >= samples_per_bucket) {
        const auto rms = static_cast<float>(std::sqrt(
            state.rms_sum / static_cast<double>(state.rms_samples)));
        std::scoped_lock signal_lock((*services_.audio_signal_mutex));
        services_.audio_rms->push_back(rms);
        state.rms_sum = 0.0;
        state.rms_samples = 0;
      }
    }
    state.samples += sample_count;
    services_.audio_end_seconds->store(
        state.audio_start_seconds
        + static_cast<double>(state.samples) / sample_rate);
  }

  void ProcessIncrementalAudioJob(
      IncrementalAudioJob job,
      IncrementalWorkerState& state) {
    if (job.generation != connection_generation_.load()
        || pending_closed_generation_.load() == job.generation) {
      if (state.generation == job.generation) {
        services_.stop_incremental_audio();
        state = IncrementalWorkerState{};
      }
      return;
    }
    if (state.generation != job.generation) {
      services_.stop_incremental_audio();
      state = IncrementalWorkerState{};
      state.generation = job.generation;
    }
    if (job.kind == IncrementalAudioJob::Kind::Frame) {
      const auto& identity = job.frame.identity;
      if (state.active
          && (state.identity.turn_id != identity.turn_id
              || state.identity.segment_message_id != identity.segment_message_id
              || state.identity.stream_id != identity.stream_id)) {
        std::cerr << "[runtime] incremental audio crossed an open segment\n";
        FailIncrementalAudio(identity, "incremental_audio_crossed_open_segment");
        services_.stop_incremental_audio();
        state = IncrementalWorkerState{};
        state.generation = job.generation;
        return;
      }
      bool accepted = false;
      bool output_open_failed = false;
      {
        std::scoped_lock sink_lock((*services_.incremental_audio_output_mutex));
        if (!state.active) {
          if (!services_.incremental_audio_output->Start(
                  job.frame.sample_rate,
                  static_cast<std::uint16_t>(job.frame.channels))) {
            std::cerr << "[runtime] failed to open incremental PCM output\n";
            output_open_failed = true;
          } else {
            state.active = true;
            state.identity = identity;
            state.samples = 0;
            state.sample_rate = 0;
            state.audio_serial = 0;
            state.audio_clock_started = false;
            state.audio_start_seconds = 0.0;
            state.rms_sum = 0.0;
            state.rms_samples = 0;
          }
        }
        if (!output_open_failed) {
          accepted = services_.incremental_audio_output->Append(job.frame.pcm);
        }
      }
      if (output_open_failed) {
        FailIncrementalAudio(identity, "incremental_audio_output_open_failed");
        state = IncrementalWorkerState{};
        state.generation = job.generation;
        return;
      }
      if (!accepted) {
        std::cerr << "[runtime] failed to accept incremental PCM frame\n";
        FailIncrementalAudio(identity, "incremental_audio_output_append_failed");
        services_.stop_incremental_audio();
        state = IncrementalWorkerState{};
        state.generation = job.generation;
        return;
      }
      UpdateIncrementalAudioSignal(
          job.frame.pcm,
          job.frame.sample_rate,
          job.frame.channels,
          state);
      if (state.audio_clock_started) {
        std::scoped_lock lock(playback_mutex_);
        const auto turn = playback_turns_.find(identity.turn_id);
        if (turn != playback_turns_.end()
            && turn->second.generation == job.generation) {
          if (auto* segment = FindIncrementalSegmentLocked(
                  identity, turn->second)) {
            segment->clock.turn_id = identity.turn_id;
            segment->clock.message_id = identity.segment_message_id;
            segment->clock.sequence = segment->sequence;
            segment->clock.started_at_seconds = state.audio_start_seconds;
            segment->clock.duration_seconds =
                static_cast<double>(state.samples)
                / std::max<std::uint32_t>(1, state.sample_rate);
            segment->clock.audio_serial = state.audio_serial;
            segment->clock.generation = job.generation;
          }
        }
      }
      auto& credit = state.credits[identity.persona_result_id];
      credit.first += job.frame.pcm.size();
      credit.second += 1;
      if (!SendIncrementalAudioCredit(
              job.frame, credit.first, credit.second)) {
        std::cerr << "[runtime] failed to send incremental audio credit\n";
        FailIncrementalAudio(identity, "incremental_audio_credit_send_failed");
        state = IncrementalWorkerState{};
        state.generation = job.generation;
      }
      return;
    }

    if (!state.active) {
      if (job.status == ag99::runtime::IncrementalOutputStatus::Completed
          && job.total_samples == 0) {
        NativeSegmentClock clock;
        clock.turn_id = job.identity.turn_id;
        clock.message_id = job.identity.segment_message_id;
        clock.sequence = static_cast<std::int64_t>(
            job.identity.segment_index);
        clock.generation = job.generation;
        const auto now = services_.now_seconds();
        clock.audio_serial = services_.audio_serial->fetch_add(1) + 1;
        services_.audio_start_seconds->store(now);
        services_.audio_end_seconds->store(now);
        services_.audio_level->store(0.0f);
        services_.reset_speech_signal();
        {
          std::scoped_lock signal_lock((*services_.audio_signal_mutex));
          services_.audio_rms->clear();
        }
        CompleteIncrementalAudio(job.identity, clock, true);
      } else if (job.status
          != ag99::runtime::IncrementalOutputStatus::Completed) {
        FailIncrementalAudio(
            job.identity,
            job.reason.empty()
                ? "incremental_audio_stream_failed"
                : job.reason);
      }
      return;
    }
    if (state.identity.turn_id != job.identity.turn_id
        || state.identity.segment_message_id != job.identity.segment_message_id
        || state.identity.stream_id != job.identity.stream_id) {
      std::cerr << "[runtime] incremental audio end identity mismatch\n";
      FailIncrementalAudio(
          job.identity, "incremental_audio_end_identity_mismatch");
      services_.stop_incremental_audio();
      state = IncrementalWorkerState{};
      state.generation = job.generation;
      return;
    }
    if (job.status != ag99::runtime::IncrementalOutputStatus::Completed) {
      {
        std::scoped_lock sink_lock((*services_.incremental_audio_output_mutex));
        services_.incremental_audio_output->WaitForDrain();
        services_.incremental_audio_output->Stop();
      }
      FailIncrementalAudio(
          job.identity,
          job.reason.empty()
              ? "incremental_audio_stream_failed"
              : job.reason);
      state = IncrementalWorkerState{};
      state.generation = job.generation;
      return;
    }
    if (job.total_samples != state.samples) {
      FailIncrementalAudio(job.identity, "incremental_audio_total_samples_mismatch");
      services_.stop_incremental_audio();
      state = IncrementalWorkerState{};
      state.generation = job.generation;
      return;
    }
    bool drained = false;
    {
      std::scoped_lock sink_lock((*services_.incremental_audio_output_mutex));
      drained = services_.incremental_audio_output->WaitForDrain();
      services_.incremental_audio_output->Stop();
    }
    if (!drained) {
      std::cerr << "[runtime] incremental PCM drain timed out\n";
      FailIncrementalAudio(job.identity, "incremental_audio_drain_timeout");
      state = IncrementalWorkerState{};
      state.generation = job.generation;
      return;
    }
    NativeSegmentClock clock;
    clock.turn_id = job.identity.turn_id;
    clock.message_id = job.identity.segment_message_id;
    clock.sequence = static_cast<std::int64_t>(job.identity.segment_index);
    clock.started_at_seconds = state.audio_start_seconds;
    clock.duration_seconds = static_cast<double>(job.total_samples)
        / std::max<std::uint32_t>(1, state.sample_rate);
    clock.audio_serial = state.audio_serial;
    clock.generation = job.generation;
    services_.audio_end_seconds->store(
        state.audio_start_seconds
        + static_cast<double>(job.total_samples)
            / std::max<std::uint32_t>(1, state.sample_rate));
    {
      std::scoped_lock signal_lock((*services_.audio_signal_mutex));
      services_.audio_rms->clear();
    }
    CompleteIncrementalAudio(job.identity, clock, true);
    state.active = false;
    state.identity = {};
    state.samples = 0;
    state.sample_rate = 0;
    state.audio_serial = 0;
    state.audio_clock_started = false;
    state.audio_start_seconds = 0.0;
    state.rms_sum = 0.0;
    state.rms_samples = 0;
  }

  void AudioWorkerLoop() {
    IncrementalWorkerState incremental_state;
    while (true) {
      AudioQueueItem item;
      IncrementalAudioJob incremental_job;
      std::string acknowledgement_turn_id;
      std::uint64_t acknowledgement_generation = 0;
      bool send_acknowledgement = false;
      bool process_incremental_audio = false;
      {
        std::unique_lock lock(services_.audio_queue->audio_queue_mutex);
        services_.audio_queue->audio_queue_condition.wait(lock, [this] {
          return closing_.load() || pending_closed_generation_.load() != 0
              || !services_.audio_queue->playback_ack_queue.empty() || !services_.audio_queue->audio_queue.empty()
              || !services_.audio_queue->incremental_audio_queue.empty();
        });
        if (closing_.load()) {
          return;
        }
        if (pending_closed_generation_.load() != 0) {
          lock.unlock();
          ProcessPendingTransportClosed();
          continue;
        }
        if (!services_.audio_queue->playback_ack_queue.empty()) {
          auto acknowledgement = std::move(services_.audio_queue->playback_ack_queue.front());
          services_.audio_queue->playback_ack_queue.pop_front();
          acknowledgement_turn_id = std::move(acknowledgement.turn_id);
          acknowledgement_generation = acknowledgement.generation;
          send_acknowledgement = true;
        } else if (!services_.audio_queue->incremental_audio_queue.empty()) {
          incremental_job = std::move(services_.audio_queue->incremental_audio_queue.front());
          services_.audio_queue->incremental_audio_queue.pop_front();
          if (incremental_job.kind == IncrementalAudioJob::Kind::Frame) {
            services_.audio_queue->incremental_audio_queued_bytes -= incremental_job.frame.pcm.size();
            services_.audio_queue->incremental_audio_queued_frames -= 1;
          }
          process_incremental_audio = true;
        } else {
          item = std::move(services_.audio_queue->audio_queue.front());
          services_.audio_queue->audio_queue.pop_front();
        }
      }
      if (send_acknowledgement) {
        TrySendPlaybackAcknowledgement(
            acknowledgement_turn_id, acknowledgement_generation);
        continue;
      }

      if (process_incremental_audio) {
        ProcessIncrementalAudioJob(std::move(incremental_job), incremental_state);
        continue;
      }

      if (item.generation != connection_generation_.load()) {
        continue;
      }
      if (!IsSegmentPlaybackOpen(item)) {
        continue;
      }

      std::string playback_failure_reason;
      const auto playback = services_.play_audio_url(
          item.segment.audio.url, playback_failure_reason);
      if (playback) {
        std::scoped_lock lock(services_.audio_queue->audio_queue_mutex);
        services_.audio_queue->current_audio_turn_id = item.turn_id;
        services_.audio_queue->current_audio_message_id = item.message_id;
        services_.audio_queue->current_audio_generation = item.generation;
        services_.audio_queue->current_audio_serial = playback->serial;
      }
      if (item.generation != connection_generation_.load()
          || pending_closed_generation_.load() == item.generation) {
        if (playback) {
          services_.stop_current_audio(playback->serial);
          ClearCurrentAudio(item, playback->serial);
        }
        ProcessPendingTransportClosed();
        continue;
      }
      if (!playback) {
        CompleteAudioSegment(item, false, playback_failure_reason);
        continue;
      }
      if (!IsSegmentPlaybackOpen(item)) {
        services_.stop_current_audio(playback->serial);
        ClearCurrentAudio(item, playback->serial);
        continue;
      }

      NativeSegmentClock playback_clock{
          item.turn_id,
          item.message_id,
          item.sequence,
          playback->started_at_seconds,
          playback->duration_seconds,
          playback->serial,
          item.generation};
      const auto deferred_motion = ActivateAudioSegment(item, playback_clock);
      if (deferred_motion) {
        ApplyMotionUpdate(
            item.turn_id,
            item.message_id,
            playback_clock,
            std::move(*deferred_motion));
      }

      bool motion_dispatch_failed = false;
      {
        std::scoped_lock transport_lock(transport_mutex_);
        if (closing_.load()
            || item.generation != connection_generation_.load()) {
          services_.stop_current_audio(playback->serial);
          ClearCurrentAudio(item, playback->serial);
          continue;
        }
        // Keep the final dispatch ordered before or after turn retirement.
        std::scoped_lock playback_lock(playback_mutex_);
        const auto turn = playback_turns_.find(item.turn_id);
        if (turn == playback_turns_.end()
            || turn->second.generation != item.generation
            || !turn->second.segments.contains(item.message_id)) {
          services_.stop_current_audio(playback->serial);
          ClearCurrentAudio(item, playback->serial);
          continue;
        }
        if (item.segment.motion.state
                == ag99::runtime::MotionSlot::State::Present) {
          NativeSegmentClock clock;
          clock.turn_id = item.turn_id;
          clock.message_id = item.message_id;
          clock.sequence = item.sequence;
          clock.started_at_seconds = playback->started_at_seconds;
          clock.duration_seconds = playback->duration_seconds;
          clock.audio_serial = playback->serial;
          clock.generation = item.generation;
          if (on_output_segment_) {
            on_output_segment_(std::move(item.segment), std::move(clock));
          } else {
            motion_dispatch_failed = true;
          }
        }
      }
      if (motion_dispatch_failed) {
        CompleteMotionSegment(NativeSegmentTerminal{
            NativeSegmentClock{
                .turn_id = item.turn_id,
                .message_id = item.message_id,
                .sequence = item.sequence,
                .started_at_seconds = playback->started_at_seconds,
                .duration_seconds = playback->duration_seconds,
                .audio_serial = playback->serial,
                .generation = item.generation},
            false,
            "motion_sink_unavailable"});
      }
      const auto deadline = playback->started_at_seconds
          + playback->duration_seconds;
      while (!closing_.load()
             && pending_closed_generation_.load() != item.generation
             && services_.audio_serial->load() == playback->serial
             && services_.now_seconds() < deadline) {
        std::this_thread::sleep_for(std::chrono::milliseconds(25));
      }
      if (pending_closed_generation_.load() == item.generation) {
        ProcessPendingTransportClosed();
        continue;
      }
      if (closing_.load()
          || services_.audio_serial->load() != playback->serial) {
        ClearCurrentAudio(item, playback->serial);
        continue;
      }
      ClearCurrentAudio(item, playback->serial);
      CompleteAudioSegment(item, true);
    }
  }

  PlaybackAckSendResult SendPlaybackFinished(
      const std::string& turn_id,
      std::uint64_t generation,
      bool success = true,
      std::optional<std::string_view> reason = std::nullopt) {
    std::scoped_lock transport_lock(transport_mutex_);
    if (closing_.load() || turn_id.empty()
        || generation != connection_generation_.load()) {
      return PlaybackAckSendResult::Canceled;
    }
    // Serialize the final active-turn check with interruption and failure.
    std::scoped_lock playback_lock(playback_mutex_);
    const auto turn = playback_turns_.find(turn_id);
    if (turn == playback_turns_.end()
        || turn->second.generation != generation
        || !turn->second.acknowledgement_claimed) {
      return PlaybackAckSendResult::Canceled;
    }
    const auto finished = ag99::runtime::build_control_playback_finished(
        turn_id,
        success,
        reason);
    return websocket_.send_text(finished.dump())
        ? PlaybackAckSendResult::Sent
        : PlaybackAckSendResult::Failed;
  }

  RuntimeCoordinatorServices services_;
  ag99::runtime::WinHttpWebSocketClient websocket_;
  ag99::native::MicrophoneCapture microphone_;
  std::mutex microphone_operation_mutex_;
  std::shared_ptr<CallbackLifetime> callback_lifetime_;
  std::function<void(ag99::runtime::ModelSync)> on_model_sync_;
  std::function<void(
      ag99::runtime::OutputSegment,
      std::optional<NativeSegmentClock>)> on_output_segment_;
  std::function<void(std::uint64_t)> on_output_segment_reset_;
  std::function<void(const std::string&)> on_turn_started_;
  std::function<void(const std::string&, bool, const std::string&)>
      on_turn_finished_;
  std::function<void(const std::string&)> on_turn_interrupted_;
  std::function<ag99::runtime::DesktopSettingsResult(
      const ag99::runtime::DesktopSettingsQuery&)> on_desktop_settings_query_;
  ag99::runtime::RuntimeProtocolSession session_;
  std::mutex session_mutex_;
  std::mutex transport_mutex_;
  std::mutex playback_mutex_;
  std::unordered_map<std::string, TurnPlaybackState> playback_turns_;
  std::atomic<bool> closing_{false};
  std::thread audio_worker_;
  std::atomic<std::uint64_t> next_turn_id_{1};
  std::atomic<std::uint64_t> next_feedback_id_{1};
  std::string last_input_turn_id_;
  std::optional<AssistantSegment> latest_assistant_segment_;
  std::atomic<std::uint64_t> connection_generation_{0};
  std::atomic<std::uint64_t> pending_closed_generation_{0};
};

NativeRuntimeCoordinator::NativeRuntimeCoordinator(
    RuntimeCoordinatorCallbacks callbacks,
    RuntimeCoordinatorServices services)
    : impl_(std::make_unique<Impl>(
          std::move(callbacks), std::move(services))) {}

NativeRuntimeCoordinator::~NativeRuntimeCoordinator() = default;

bool NativeRuntimeCoordinator::Connect(const std::string& url) {
  return impl_->Connect(url);
}

bool NativeRuntimeCoordinator::Reconnect() {
  return impl_->Reconnect();
}

bool NativeRuntimeCoordinator::SendText(std::string_view text) {
  return impl_->SendText(text);
}

bool NativeRuntimeCoordinator::InterruptCurrentTurn() {
  return impl_->InterruptCurrentTurn();
}

bool NativeRuntimeCoordinator::ApproveLatestAssistantSegment() {
  return impl_->ApproveLatestAssistantSegment();
}

bool NativeRuntimeCoordinator::ToggleMicrophone() {
  return impl_->ToggleMicrophone();
}

bool NativeRuntimeCoordinator::MicrophoneRunning() const noexcept {
  return impl_->MicrophoneRunning();
}

void NativeRuntimeCoordinator::NotifyMotionTerminal(
    NativeSegmentTerminal terminal) {
  impl_->NotifyMotionTerminal(std::move(terminal));
}

void NativeRuntimeCoordinator::Close() {
  impl_->Close();
}

}  // namespace ag99::native
