#include <windows.h>

#include <algorithm>
#include <atomic>
#include <cctype>
#include <functional>
#include <iostream>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <string_view>
#include <unordered_map>
#include <utility>
#include <vector>

#include "ag99/native/native_input_runtime.hpp"
#include "ag99/native/native_playback_runtime.hpp"
#include "ag99/native/native_transport.hpp"
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
        input_runtime_(transport_.Client()),
        bilibili_([this](std::string text) {
          return transport_.SendText(text);
        }),
        callback_lifetime_(std::make_shared<CallbackLifetime>()),
        on_model_sync_(std::move(callbacks.on_model_sync)),
        on_pre_action_(std::move(callbacks.on_pre_action)),
        on_desktop_observation_request_(
            std::move(callbacks.on_desktop_observation_request)),
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
            [this](ag99::runtime::PreActionEvent event) {
              if (on_pre_action_) {
                on_pre_action_(std::move(event));
              }
            },
            [this](ag99::runtime::DesktopObservationRequest request) {
              HandleDesktopObservationRequest(std::move(request));
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
              ag99::runtime::DesktopSettingsResult result;
              if (query.key == "microphone_device") {
                result = input_runtime_.HandleDeviceSetting(query);
              } else if (query.key == "adapter_address") {
                result = HandleAdapterAddressSetting(query);
              } else if (query.key == "bilibili_live_enabled"
                  || query.key == "bilibili_live_room_id"
                  || query.key == "bilibili_live_cookie"
                  || query.key == "bilibili_live_response_interval") {
                result = bilibili_.HandleSetting(query);
              } else {
                result = on_desktop_settings_query_
                    ? on_desktop_settings_query_(query)
                  : ag99::runtime::DesktopSettingsResult{
                        query.request_id, query.key, std::nullopt,
                        "desktop_setting_unsupported"};
              }
              const auto reply =
                  ag99::runtime::build_system_desktop_settings_result(result);
              // InvalidateConnection takes session_mutex_ before replacing the
              // socket. Do not take transport_mutex_ from a receive callback.
              if (!transport_.SendText(reply.dump())) {
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
    playback_runtime_ = std::make_unique<NativePlaybackRuntime>(
        NativePlaybackRuntimeServices{
            .audio_runtime = services_.audio_runtime,
            .closing = [this] { return closing_.load(); },
            .connection_generation = [this] {
              return connection_generation_.load();
            },
            .pending_closed_generation = [this] {
              return pending_closed_generation_.load();
            },
            .now_seconds = services_.now_seconds,
            .play_audio_url = services_.play_audio_url,
            .stop_current_audio = services_.stop_current_audio,
            .stop_incremental_audio = services_.stop_incremental_audio,
            .reset_speech_signal = services_.reset_speech_signal,
            .send_incremental_audio_credit = [this](
                const ag99::runtime::OutputAudioFrame& frame,
                std::uint64_t released_bytes,
                std::uint64_t released_frames) {
              return SendIncrementalAudioCredit(
                  frame, released_bytes, released_frames);
            },
            .fail_incremental_audio = [this](
                const ag99::runtime::IncrementalIdentity& identity,
                std::string_view reason) {
              FailIncrementalAudio(identity, reason);
            },
            .complete_incremental_audio = [this](
                const ag99::runtime::IncrementalIdentity& identity,
                NativeSegmentClock clock,
                bool success,
                std::string_view reason) {
              CompleteIncrementalAudio(identity, std::move(clock), success, reason);
            },
            .update_incremental_audio_clock = [this](
                const ag99::runtime::IncrementalIdentity& identity,
                const NativeSegmentClock& clock) {
              UpdateIncrementalAudioClock(identity, clock);
            },
            .is_segment_playback_open = [this](const AudioQueueItem& item) {
              return IsSegmentPlaybackOpen(item);
            },
            .activate_audio_segment = [this](
                const AudioQueueItem& item,
                const NativeSegmentClock& clock) {
              return ActivateAudioSegment(item, clock);
            },
            .apply_motion_update = [this](
                const std::string& turn_id,
                const std::string& message_id,
                const NativeSegmentClock& clock,
                ag99::runtime::MotionSlot motion) {
              ApplyMotionUpdate(turn_id, message_id, clock, std::move(motion));
            },
            .complete_audio_segment = [this](
                const AudioQueueItem& item,
                bool success,
                std::string_view reason) {
              CompleteAudioSegment(item, success, reason);
            },
            .complete_motion_segment = [this](NativeSegmentTerminal terminal) {
              CompleteMotionSegment(std::move(terminal));
            },
            .process_pending_transport_closed = [this] {
              ProcessPendingTransportClosed();
            },
            .dispatch_output_segment = [this](
                ag99::runtime::OutputSegment segment,
                NativeSegmentClock clock) {
              return DispatchPlaybackMotionSegment(
                  std::move(segment), std::move(clock));
            },
            .try_send_playback_acknowledgement = [this](
                const std::string& turn_id,
                std::uint64_t generation) {
              TrySendPlaybackAcknowledgement(turn_id, generation);
            }});
    playback_runtime_->Start();
  }

  ~Impl() {
    Close();
  }

  bool Connect(const std::string& url) {
    std::scoped_lock transport_lock(transport_mutex_);
    if (closing_.load()) {
      return false;
    }
    {
      std::scoped_lock lock(adapter_url_mutex_);
      adapter_url_ = url;
    }
    const auto generation = InvalidateConnection();

    // Stop the previous capture before closing the transport so its stream
    // end marker can still be delivered when the old connection is usable.
    input_runtime_.Stop("runtime_reconnect");
    transport_.Close();
    ResetDisconnectedState();

    const std::weak_ptr<CallbackLifetime> weak_lifetime = callback_lifetime_;
    bool connected = transport_.Connect(
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
      auto settings_with_capabilities = settings;
      settings_with_capabilities["payload"]["desktop_observation_schema"] =
          "ag99live.desktop_observation.v1";
      if (!transport_.SendText(settings_with_capabilities.dump())) {
        transport_.Close();
        connected = false;
      }
    }
    services_.set_runtime_connected(connected);
    services_.notify_input_connection_changed();
    return connected;
  }

  bool Reconnect() {
    std::string url;
    {
      std::scoped_lock lock(adapter_url_mutex_);
      url = adapter_url_;
    }
    return Connect(url);
  }

  void HandleDesktopObservationRequest(
      ag99::runtime::DesktopObservationRequest request) {
    std::string error;
    const auto image = services_.capture_desktop_jpeg
        ? services_.capture_desktop_jpeg(error)
        : std::nullopt;
    ag99::runtime::Json payload = {
        {"schema_version", "ag99live.desktop_observation.v1"},
        {"request_id", request.request_id},
        {"ok", image.has_value()},
    };
    if (image) {
      payload["mime_type"] = "image/jpeg";
      payload["data"] = *image;
    } else {
      payload["error"] = error.empty()
          ? "desktop_capture_unavailable" : error;
    }
    const auto response = ag99::runtime::build_envelope(
        "system.desktop_observation_result", payload, std::nullopt,
        "frontend");
    if (!transport_.SendText(response.dump())) {
      std::cerr << "[runtime] failed to send desktop observation result\n";
    }
  }

  ag99::runtime::DesktopSettingsResult HandleAdapterAddressSetting(
      const ag99::runtime::DesktopSettingsQuery& query) {
    ag99::runtime::DesktopSettingsResult result{
        query.request_id,
        query.key,
        std::nullopt,
        {}};
    std::scoped_lock lock(adapter_url_mutex_);
    if (query.action == "set") {
      const auto requested = query.value.value_or("");
      if (!IsAdapterAddress(requested)) {
        result.error = "desktop_setting_value_invalid";
        return result;
      }
      adapter_url_ = requested;
    }
    result.entry = ag99::runtime::DesktopSettingsEntry{
        adapter_url_,
        {},
        std::nullopt,
        std::nullopt,
        std::nullopt};
    return result;
  }

  bool SendText(std::string_view text) {
    const auto message = services_.trim_ascii_text(std::string(text));
    if (message.empty() || !services_.runtime_connected()) {
      return false;
    }
    const auto turn_id = "native-demo-" +
        std::to_string(next_turn_id_.fetch_add(1));
    const auto envelope = ag99::runtime::build_input_text(message, {}, turn_id);
    const bool sent = transport_.SendText(envelope.dump());
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
    const bool sent = transport_.SendText(envelope.dump());
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
    if (transport_.SendText(envelope.dump())) {
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
    if (closing_.load()) {
      return false;
    }
    return input_runtime_.ToggleMicrophone();
  }

  bool MicrophoneRunning() const noexcept {
    return input_runtime_.Running();
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
      input_runtime_.Stop("runtime_shutdown");
      bilibili_.Close();
      transport_.Close();
      ResetDisconnectedState();
    }
    services_.set_runtime_connected(false);
    services_.notify_input_connection_changed();
    services_.audio_runtime->NotifyQueueAll();
    transport_lock.unlock();
    if (playback_runtime_) {
      playback_runtime_->Join();
    }
    if (!was_closing) {
      services_.stop_current_audio(std::nullopt);
      services_.stop_incremental_audio();
    }
  }

private:
  static bool IsAdapterAddress(std::string_view value) {
    if (!(value.starts_with("ws://") || value.starts_with("wss://"))) {
      return false;
    }
    if (value.size() <= 5) {
      return false;
    }
    return std::none_of(value.begin(), value.end(), [](unsigned char character) {
      return std::isspace(character) != 0;
    });
  }

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
        || services_.audio_runtime->AudioSerial() != clock.audio_serial
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

  void UpdateIncrementalAudioClock(
      const ag99::runtime::IncrementalIdentity& identity,
      const NativeSegmentClock& clock) {
    std::scoped_lock lock(playback_mutex_);
    const auto turn = playback_turns_.find(identity.turn_id);
    if (turn == playback_turns_.end()
        || turn->second.generation != clock.generation) {
      return;
    }
    if (auto* segment = FindIncrementalSegmentLocked(identity, turn->second)) {
      segment->clock = clock;
    }
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
      const auto audio_serial_to_stop = services_.audio_runtime->ClearTurnQueues(turn_id);
      if (audio_serial_to_stop) {
        services_.stop_current_audio(*audio_serial_to_stop);
      }
      services_.stop_incremental_audio();
      services_.audio_runtime->NotifyQueueOne();
    }
  }

  void ClearCurrentAudio(
      const AudioQueueItem& item,
      std::uint64_t audio_serial) {
    services_.audio_runtime->ClearCurrentAudioIfMatches(
        item.turn_id, item.message_id, item.generation, audio_serial);
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
    services_.audio_runtime->EnqueueAcknowledgement(
        PlaybackAcknowledgementItem{turn_id, generation});
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
    const bool rejected = closing_.load()
        || !services_.audio_runtime->EnqueueIncremental(
            std::move(job), std::size_t(-1), kMaxIncrementalAudioJobs);
    if (rejected) {
      FailIncrementalAudio(event.identity, "incremental_audio_job_capacity_exceeded");
      return;
    }
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
    const auto job_identity = job.identity;
    const bool rejected = closing_.load()
        || !services_.audio_runtime->EnqueueIncremental(
            std::move(job), kIncrementalAudioWindowBytes,
            kIncrementalAudioWindowFrames);
    if (rejected) {
      FailIncrementalAudio(
          job_identity, "incremental_audio_credit_window_exceeded");
      return;
    }
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
      if (!closing_.load() && !transport_.SendText(interrupt.dump())) {
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
    services_.audio_runtime->ClearAllQueues();
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
    services_.audio_runtime->NotifyQueueAll();
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
    input_runtime_.Stop("websocket_closed");
    transport_.Close();
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
      if (closing_.load()) {
        return;
      }
      services_.audio_runtime->EnqueueSegment(std::move(item));
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

  NativePlaybackDispatchResult DispatchPlaybackMotionSegment(
      ag99::runtime::OutputSegment segment,
      NativeSegmentClock clock) {
    std::scoped_lock transport_lock(transport_mutex_);
    if (closing_.load() || clock.generation != connection_generation_.load()) {
      return NativePlaybackDispatchResult::Stale;
    }
    std::scoped_lock playback_lock(playback_mutex_);
    const auto turn = playback_turns_.find(clock.turn_id);
    if (turn == playback_turns_.end()
        || turn->second.generation != clock.generation
        || !turn->second.segments.contains(clock.message_id)) {
      return NativePlaybackDispatchResult::Stale;
    }
    if (!on_output_segment_) {
      return NativePlaybackDispatchResult::Unavailable;
    }
    on_output_segment_(std::move(segment), std::move(clock));
    return NativePlaybackDispatchResult::Dispatched;
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
    return transport_.SendText(credit.dump());
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
    return transport_.SendText(finished.dump())
        ? PlaybackAckSendResult::Sent
        : PlaybackAckSendResult::Failed;
  }

  RuntimeCoordinatorServices services_;
  NativeTransport transport_;
  ag99::native::NativeInputRuntime input_runtime_;
  ag99::native::BilibiliLiveRuntime bilibili_;
  std::mutex adapter_url_mutex_;
  std::string adapter_url_ = "ws://127.0.0.1:12396";
  std::shared_ptr<CallbackLifetime> callback_lifetime_;
  std::function<void(ag99::runtime::ModelSync)> on_model_sync_;
  std::function<void(ag99::runtime::PreActionEvent)> on_pre_action_;
  std::function<void(ag99::runtime::DesktopObservationRequest)>
      on_desktop_observation_request_;
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
  std::unique_ptr<NativePlaybackRuntime> playback_runtime_;
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
