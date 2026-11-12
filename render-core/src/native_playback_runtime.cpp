#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <iostream>
#include <span>
#include <string>
#include <thread>
#include <utility>

#include "ag99/native/native_playback_runtime.hpp"

namespace ag99::native {

namespace {

}  // namespace

struct NativePlaybackRuntime::Impl {
  explicit Impl(NativePlaybackRuntimeServices services)
      : services_(std::move(services)) {}

  void Start() {
    worker_ = std::thread([this] { AudioWorkerLoop(); });
  }

  void Join() {
    if (worker_.joinable()) {
      worker_.join();
    }
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
      state.audio_serial = services_.audio_runtime->NextAudioSerial();
      services_.audio_runtime->SetAudioClock(
          state.audio_start_seconds, state.audio_start_seconds);
      services_.audio_runtime->ResetAudioRms();
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
        services_.audio_runtime->AppendAudioRms(rms);
        state.rms_sum = 0.0;
        state.rms_samples = 0;
      }
    }
    state.samples += sample_count;
    services_.audio_runtime->SetAudioClock(
        services_.audio_runtime->AudioStartSeconds(),
        state.audio_start_seconds
            + static_cast<double>(state.samples) / sample_rate);
  }

  void ProcessIncrementalAudioJob(
      IncrementalAudioJob job,
      IncrementalWorkerState& state) {
    if (job.generation != services_.connection_generation()
        || services_.pending_closed_generation() == job.generation) {
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
        services_.fail_incremental_audio(
            identity, "incremental_audio_crossed_open_segment");
        services_.stop_incremental_audio();
        state = IncrementalWorkerState{};
        state.generation = job.generation;
        return;
      }
      bool accepted = false;
      bool output_open_failed = false;
      if (!state.active) {
        if (!services_.audio_runtime->StartIncrementalAudioOutput(
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
        accepted = services_.audio_runtime->AppendIncrementalAudio(
            job.frame.pcm);
      }
      if (output_open_failed) {
        services_.fail_incremental_audio(
            identity, "incremental_audio_output_open_failed");
        state = IncrementalWorkerState{};
        state.generation = job.generation;
        return;
      }
      if (!accepted) {
        std::cerr << "[runtime] failed to accept incremental PCM frame\n";
        services_.fail_incremental_audio(
            identity, "incremental_audio_output_append_failed");
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
        NativeSegmentClock clock;
        clock.turn_id = identity.turn_id;
        clock.message_id = identity.segment_message_id;
        clock.sequence = static_cast<std::int64_t>(identity.segment_index);
        clock.started_at_seconds = state.audio_start_seconds;
        clock.duration_seconds = static_cast<double>(state.samples)
            / std::max<std::uint32_t>(1, state.sample_rate);
        clock.audio_serial = state.audio_serial;
        clock.generation = job.generation;
        services_.update_incremental_audio_clock(identity, clock);
      }
      auto& credit = state.credits[identity.persona_result_id];
      credit.first += job.frame.pcm.size();
      credit.second += 1;
      if (!services_.send_incremental_audio_credit(
              job.frame, credit.first, credit.second)) {
        std::cerr << "[runtime] failed to send incremental audio credit\n";
        services_.fail_incremental_audio(
            identity, "incremental_audio_credit_send_failed");
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
        clock.audio_serial = services_.audio_runtime->NextAudioSerial();
        services_.audio_runtime->SetAudioClock(now, now);
        services_.audio_runtime->SetAudioLevel(0.0f);
        services_.reset_speech_signal();
        services_.audio_runtime->ResetAudioRms();
        services_.complete_incremental_audio(
            job.identity, clock, true, {});
      } else if (job.status
          != ag99::runtime::IncrementalOutputStatus::Completed) {
        services_.fail_incremental_audio(
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
      services_.fail_incremental_audio(
          job.identity, "incremental_audio_end_identity_mismatch");
      services_.stop_incremental_audio();
      state = IncrementalWorkerState{};
      state.generation = job.generation;
      return;
    }
    if (job.status != ag99::runtime::IncrementalOutputStatus::Completed) {
      services_.audio_runtime->DrainIncrementalAudio();
      services_.audio_runtime->StopIncrementalAudio();
      services_.fail_incremental_audio(
          job.identity,
          job.reason.empty()
              ? "incremental_audio_stream_failed"
              : job.reason);
      state = IncrementalWorkerState{};
      state.generation = job.generation;
      return;
    }
    const auto drained = services_.audio_runtime->DrainIncrementalAudio();
    services_.audio_runtime->StopIncrementalAudio();
    if (!drained) {
      std::cerr << "[runtime] incremental PCM drain timed out\n";
      services_.fail_incremental_audio(
          job.identity, "incremental_audio_drain_timeout");
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
    services_.audio_runtime->SetAudioClock(
        services_.audio_runtime->AudioStartSeconds(),
        state.audio_start_seconds
            + static_cast<double>(job.total_samples)
                / std::max<std::uint32_t>(1, state.sample_rate));
    services_.audio_runtime->ResetAudioRms();
    services_.complete_incremental_audio(job.identity, clock, true, {});
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
      AudioQueueWork work;
      if (!services_.audio_runtime->WaitAndTakeWork(
              work,
              [this] {
                return services_.closing()
                    || services_.pending_closed_generation() != 0;
              })) {
        return;
      }
      if (services_.closing()) {
        return;
      }
      if (services_.pending_closed_generation() != 0) {
        services_.process_pending_transport_closed();
        continue;
      }
      if (work.acknowledgement) {
        services_.try_send_playback_acknowledgement(
            work.acknowledgement->turn_id,
            work.acknowledgement->generation);
        continue;
      }
      if (work.incremental) {
        incremental_job = std::move(*work.incremental);
        ProcessIncrementalAudioJob(std::move(incremental_job), incremental_state);
        continue;
      }
      if (!work.segment) {
        continue;
      }
      item = std::move(*work.segment);
      if (item.generation != services_.connection_generation()
          || !services_.is_segment_playback_open(item)) {
        continue;
      }

      std::string playback_failure_reason;
      const auto playback = services_.play_audio_url(
          item.segment.audio.url, playback_failure_reason);
      if (playback) {
        services_.audio_runtime->SetCurrentAudio(
            item.turn_id, item.message_id, item.generation, playback->serial);
      }
      if (item.generation != services_.connection_generation()
          || services_.pending_closed_generation() == item.generation) {
        if (playback) {
          services_.stop_current_audio(playback->serial);
          services_.audio_runtime->ClearCurrentAudioIfMatches(
              item.turn_id, item.message_id, item.generation, playback->serial);
        }
        services_.process_pending_transport_closed();
        continue;
      }
      if (!playback) {
        services_.complete_audio_segment(item, false, playback_failure_reason);
        continue;
      }
      if (!services_.is_segment_playback_open(item)) {
        services_.stop_current_audio(playback->serial);
        services_.audio_runtime->ClearCurrentAudioIfMatches(
            item.turn_id, item.message_id, item.generation, playback->serial);
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
      if (const auto deferred_motion = services_.activate_audio_segment(
              item, playback_clock)) {
        services_.apply_motion_update(
            item.turn_id,
            item.message_id,
            playback_clock,
            std::move(*deferred_motion));
      }

      auto dispatch_result = NativePlaybackDispatchResult::Dispatched;
      if (item.segment.motion.state
          == ag99::runtime::MotionSlot::State::Present) {
        NativeSegmentClock clock = playback_clock;
        dispatch_result = services_.dispatch_output_segment(
            std::move(item.segment), std::move(clock));
      }
      if (dispatch_result == NativePlaybackDispatchResult::Stale) {
        services_.stop_current_audio(playback->serial);
        services_.audio_runtime->ClearCurrentAudioIfMatches(
            item.turn_id, item.message_id, item.generation, playback->serial);
        continue;
      }
      if (dispatch_result == NativePlaybackDispatchResult::Unavailable) {
        services_.complete_motion_segment(NativeSegmentTerminal{
            playback_clock, false, "motion_sink_unavailable"});
      }

      const auto deadline = playback->started_at_seconds
          + playback->duration_seconds;
      while (!services_.closing()
             && services_.pending_closed_generation() != item.generation
             && services_.audio_runtime->AudioSerial() == playback->serial
             && services_.now_seconds() < deadline) {
        std::this_thread::sleep_for(std::chrono::milliseconds(25));
      }
      if (services_.pending_closed_generation() == item.generation) {
        services_.process_pending_transport_closed();
        continue;
      }
      if (services_.closing()
          || services_.audio_runtime->AudioSerial() != playback->serial) {
        services_.audio_runtime->ClearCurrentAudioIfMatches(
            item.turn_id, item.message_id, item.generation, playback->serial);
        continue;
      }
      services_.audio_runtime->ClearCurrentAudioIfMatches(
          item.turn_id, item.message_id, item.generation, playback->serial);
      services_.complete_audio_segment(item, true, {});
    }
  }

  NativePlaybackRuntimeServices services_;
  std::thread worker_;
};

NativePlaybackRuntime::NativePlaybackRuntime(
    NativePlaybackRuntimeServices services)
    : impl_(std::make_unique<Impl>(std::move(services))) {}

NativePlaybackRuntime::~NativePlaybackRuntime() {
  Join();
}

void NativePlaybackRuntime::Start() {
  impl_->Start();
}

void NativePlaybackRuntime::Join() {
  impl_->Join();
}

}  // namespace ag99::native
