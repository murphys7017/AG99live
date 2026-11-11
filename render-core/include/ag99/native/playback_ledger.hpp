#pragma once

#include <cstdint>
#include <condition_variable>
#include <deque>
#include <mutex>
#include <optional>
#include <string>
#include <unordered_map>
#include <utility>

#include "ag99/native/runtime_coordinator.hpp"

namespace ag99::native {

struct IncrementalAudioJob {
  enum class Kind { Frame, End };
  Kind kind = Kind::Frame;
  ag99::runtime::OutputAudioFrame frame;
  ag99::runtime::IncrementalIdentity identity;
  std::uint64_t total_samples = 0;
  ag99::runtime::IncrementalOutputStatus status =
      ag99::runtime::IncrementalOutputStatus::Completed;
  std::string reason;
  std::uint64_t generation = 0;
};

struct IncrementalWorkerState {
  bool active = false;
  ag99::runtime::IncrementalIdentity identity;
  std::uint64_t generation = 0;
  std::uint64_t samples = 0;
  std::uint32_t sample_rate = 0;
  std::uint64_t audio_serial = 0;
  bool audio_clock_started = false;
  double audio_start_seconds = 0.0;
  double rms_sum = 0.0;
  std::size_t rms_samples = 0;
  std::unordered_map<std::string, std::pair<std::uint64_t, std::uint64_t>>
      credits;
};

struct AudioQueueItem {
  ag99::runtime::OutputSegment segment;
  std::string turn_id;
  std::string message_id;
  std::int64_t sequence = 0;
  std::uint64_t generation = 0;
};

struct PlaybackAcknowledgementItem {
  std::string turn_id;
  std::uint64_t generation = 0;
};

struct SegmentPlaybackState {
  std::int64_t sequence = 0;
  bool audio_terminal = true;
  bool motion_terminal = true;
  bool motion_pending = false;
  NativeSegmentClock clock;
  std::optional<ag99::runtime::MotionSlot> deferred_motion;
  std::string text_failure_reason;
  std::string audio_failure_reason;
  std::string motion_failure_reason;
};

struct IncrementalSegmentPlaybackState {
  std::int64_t sequence = 0;
  bool text_terminal = false;
  bool audio_terminal = false;
  bool motion_stream_terminal = false;
  bool motion_terminal = false;
  bool motion_dispatched = false;
  NativeSegmentClock clock;
  ag99::runtime::MotionSlot latest_motion;
  double motion_received_at_seconds = 0.0;
  std::string text_failure_reason;
  std::string audio_failure_reason;
  std::string motion_failure_reason;
};

struct TurnPlaybackState {
  std::uint64_t generation = 0;
  bool synth_finished = false;
  bool acknowledgement_queued = false;
  bool acknowledgement_claimed = false;
  std::unordered_map<std::string, SegmentPlaybackState> segments;
  std::unordered_map<std::string, IncrementalSegmentPlaybackState>
      incremental_segments;
  std::unordered_map<std::string, std::string> incremental_text;
};

enum class PlaybackAckSendResult {
  Sent,
  Canceled,
  Failed,
};

struct AudioQueueState {
  std::mutex audio_queue_mutex;
  std::mutex audio_join_mutex;
  std::condition_variable audio_queue_condition;
  std::deque<AudioQueueItem> audio_queue;
  std::deque<IncrementalAudioJob> incremental_audio_queue;
  std::size_t incremental_audio_queued_bytes = 0;
  std::size_t incremental_audio_queued_frames = 0;
  std::deque<PlaybackAcknowledgementItem> playback_ack_queue;
  std::string current_audio_turn_id;
  std::string current_audio_message_id;
  std::uint64_t current_audio_generation = 0;
  std::uint64_t current_audio_serial = 0;
};

}  // namespace ag99::native
