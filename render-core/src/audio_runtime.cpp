#include <windows.h>
#include <mmsystem.h>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <iostream>
#include <utility>

#include "ag99/native/audio_runtime.hpp"
#include "ag99/native/playback_ledger.hpp"

namespace ag99::native {

namespace {

DWORD VolumeWord(float volume) noexcept {
  const auto normalized = std::clamp(volume, 0.0f, 1.0f);
  const auto word = static_cast<DWORD>(std::lround(normalized * 0xffff));
  return word | (word << 16);
}

}  // namespace

AudioRuntime::AudioRuntime()
    : queue_(std::make_unique<AudioQueueState>()) {}

AudioRuntime::~AudioRuntime() {
  StopCurrentAudio();
  StopIncrementalAudio();
}

std::optional<AudioPlayback> AudioRuntime::PlayAudioUrl(
    const std::string& url,
    std::string& failure_reason) {
  std::vector<std::uint8_t> bytes;
  if (!ag99::audio::DownloadAudioWav(url, bytes)) {
    failure_reason = "audio_download_failed";
    std::cerr << "Failed to download audio: " << url << '\n';
    return std::nullopt;
  }
  const auto info = ag99::audio::ParsePcmWav(bytes);
  if (!info) {
    failure_reason = "audio_wav_invalid";
    std::cerr << "Downloaded WAV has no valid PCM playback format: "
              << url << '\n';
    return std::nullopt;
  }
  const auto duration = static_cast<double>(info->data_size) / info->byte_rate;
  const auto rms = ag99::audio::ReadWavRms(bytes);
  std::uint64_t serial = 0;
  double started_at_seconds = 0.0;
  bool playback_started = false;
  {
    std::scoped_lock lock(audio_output_mutex_);
    serial = audio_serial_.fetch_add(1) + 1;
    playback_started = audio_output_.Start(*info, std::move(bytes));
    if (playback_started) {
      started_at_seconds = std::chrono::duration<double>(
          std::chrono::steady_clock::now().time_since_epoch()).count();
      {
        std::scoped_lock signal_lock(audio_signal_mutex_);
        audio_rms_ = rms;
      }
      audio_start_seconds_.store(started_at_seconds);
      audio_end_seconds_.store(started_at_seconds + duration);
    }
  }
  if (!playback_started) {
    failure_reason = "audio_playback_failed";
    std::cerr << "waveOut failed to start downloaded WAV: " << url << '\n';
    StopCurrentAudio(serial);
    return std::nullopt;
  }
  failure_reason.clear();
  return AudioPlayback{duration, serial, started_at_seconds};
}

void AudioRuntime::StopCurrentAudio(
    std::optional<std::uint64_t> expected_serial) {
  std::scoped_lock lock(audio_output_mutex_);
  if (expected_serial && audio_serial_.load() != *expected_serial) {
    return;
  }
  audio_serial_.fetch_add(1);
  audio_output_.Stop();
  audio_end_seconds_.store(0.0);
  audio_start_seconds_.store(0.0);
  audio_level_.store(0.0f);
  ResetSpeechSignal();
  std::scoped_lock signal_lock(audio_signal_mutex_);
  audio_rms_.clear();
}

void AudioRuntime::StopIncrementalAudio() {
  std::scoped_lock lock(incremental_audio_output_mutex_);
  incremental_audio_output_.Stop();
  audio_serial_.fetch_add(1);
  audio_end_seconds_.store(0.0);
  audio_start_seconds_.store(0.0);
  audio_level_.store(0.0f);
  ResetSpeechSignal();
  std::scoped_lock signal_lock(audio_signal_mutex_);
  audio_rms_.clear();
}

bool AudioRuntime::StartIncrementalAudioOutput(
    std::uint32_t sample_rate, std::uint16_t channels) {
  std::scoped_lock lock(incremental_audio_output_mutex_);
  return incremental_audio_output_.Start(sample_rate, channels);
}

bool AudioRuntime::AppendIncrementalAudio(
    std::span<const std::uint8_t> pcm) {
  std::scoped_lock lock(incremental_audio_output_mutex_);
  return incremental_audio_output_.Append(pcm);
}

bool AudioRuntime::DrainIncrementalAudio(std::chrono::milliseconds timeout) {
  std::scoped_lock lock(incremental_audio_output_mutex_);
  return incremental_audio_output_.WaitForDrain(timeout);
}

void AudioRuntime::SetSpeechVolume(float volume) noexcept {
  const auto normalized = std::clamp(volume, 0.0f, 1.0f);
  speech_volume_.store(normalized);
  {
    std::scoped_lock lock(audio_output_mutex_);
    audio_output_.SetVolume(normalized);
  }
  {
    std::scoped_lock lock(incremental_audio_output_mutex_);
    incremental_audio_output_.SetVolume(normalized);
  }
}

void AudioRuntime::UpdateAudioLevel(float delta_seconds, double now) {
  const double remaining = audio_end_seconds_.load() - now;
  float level = 0.0f;
  if (remaining <= 0.0) {
    audio_level_.store(0.0f);
  } else {
    const double elapsed = std::max(
        0.0,
        now - audio_start_seconds_.load());
    std::scoped_lock lock(audio_signal_mutex_);
    const auto index = static_cast<std::size_t>(elapsed * 50.0);
    if (index < audio_rms_.size()) {
      level = std::max(0.0f, audio_rms_[index]);
    }
    audio_level_.store(level);
  }
  speech_signal_.Update(level, delta_seconds);
}

float AudioRuntime::SpeechAudioGain(std::string_view axis_id) const {
  return speech_signal_.AudioGain(axis_id);
}

float AudioRuntime::SpeechLipSyncIntensity() const {
  return speech_signal_.LipSyncIntensity();
}

void AudioRuntime::ResetSpeechSignal() {
  speech_signal_.Reset();
}

void AudioRuntime::ResetAudioRms() {
  std::scoped_lock lock(audio_signal_mutex_);
  audio_rms_.clear();
}

void AudioRuntime::AppendAudioRms(float rms) {
  std::scoped_lock lock(audio_signal_mutex_);
  audio_rms_.push_back(rms);
}

void AudioRuntime::EnqueueSegment(AudioQueueItem item) {
  {
    std::scoped_lock lock(queue_->audio_queue_mutex);
    queue_->audio_queue.push_back(std::move(item));
  }
  queue_->audio_queue_condition.notify_one();
}

bool AudioRuntime::EnqueueIncremental(
    IncrementalAudioJob job,
    std::size_t max_bytes,
    std::size_t max_frames) {
  {
    std::scoped_lock lock(queue_->audio_queue_mutex);
    const auto next_bytes = queue_->incremental_audio_queued_bytes
        + job.frame.pcm.size();
    const auto next_frames = queue_->incremental_audio_queued_frames + 1;
    if (next_bytes > max_bytes
        || next_frames > max_frames
        || queue_->incremental_audio_queue.size() >= max_frames) {
      return false;
    }
    queue_->incremental_audio_queued_bytes = next_bytes;
    queue_->incremental_audio_queued_frames = next_frames;
    queue_->incremental_audio_queue.push_back(std::move(job));
  }
  queue_->audio_queue_condition.notify_one();
  return true;
}

void AudioRuntime::EnqueueAcknowledgement(PlaybackAcknowledgementItem item) {
  {
    std::scoped_lock lock(queue_->audio_queue_mutex);
    queue_->playback_ack_queue.push_back(std::move(item));
  }
  queue_->audio_queue_condition.notify_one();
}

bool AudioRuntime::WaitAndTakeWork(
    AudioQueueWork& work,
    const std::function<bool()>& stop_requested) {
  std::unique_lock lock(queue_->audio_queue_mutex);
  queue_->audio_queue_condition.wait(lock, [&] {
    return stop_requested()
        || !queue_->playback_ack_queue.empty()
        || !queue_->incremental_audio_queue.empty()
        || !queue_->audio_queue.empty();
  });
  if (stop_requested()
      && queue_->playback_ack_queue.empty()
      && queue_->incremental_audio_queue.empty()
      && queue_->audio_queue.empty()) {
    return false;
  }
  work = {};
  if (!queue_->playback_ack_queue.empty()) {
    work.acknowledgement = std::move(queue_->playback_ack_queue.front());
    queue_->playback_ack_queue.pop_front();
  } else if (!queue_->incremental_audio_queue.empty()) {
    work.incremental = std::move(queue_->incremental_audio_queue.front());
    queue_->incremental_audio_queue.pop_front();
    queue_->incremental_audio_queued_bytes -= work.incremental->frame.pcm.size();
    queue_->incremental_audio_queued_frames -= 1;
  } else if (!queue_->audio_queue.empty()) {
    work.segment = std::move(queue_->audio_queue.front());
    queue_->audio_queue.pop_front();
  }
  return true;
}

std::optional<std::uint64_t> AudioRuntime::ClearTurnQueues(
    std::string_view turn_id) {
  std::optional<std::uint64_t> audio_serial;
  {
    std::scoped_lock lock(queue_->audio_queue_mutex);
    for (auto it = queue_->audio_queue.begin(); it != queue_->audio_queue.end();) {
      if (it->turn_id == turn_id) {
        it = queue_->audio_queue.erase(it);
      } else {
        ++it;
      }
    }
    for (auto it = queue_->incremental_audio_queue.begin();
         it != queue_->incremental_audio_queue.end();) {
      if (it->identity.turn_id == turn_id) {
        queue_->incremental_audio_queued_bytes -= it->frame.pcm.size();
        queue_->incremental_audio_queued_frames -= 1;
        it = queue_->incremental_audio_queue.erase(it);
      } else {
        ++it;
      }
    }
    queue_->playback_ack_queue.erase(
        std::remove_if(
            queue_->playback_ack_queue.begin(),
            queue_->playback_ack_queue.end(),
            [&](const PlaybackAcknowledgementItem& item) {
              return item.turn_id == turn_id;
            }),
        queue_->playback_ack_queue.end());
    if (queue_->current_audio_turn_id == turn_id) {
      audio_serial = queue_->current_audio_serial;
      queue_->current_audio_turn_id.clear();
      queue_->current_audio_message_id.clear();
      queue_->current_audio_generation = 0;
      queue_->current_audio_serial = 0;
    }
  }
  queue_->audio_queue_condition.notify_one();
  return audio_serial;
}

void AudioRuntime::ClearAllQueues() {
  {
    std::scoped_lock lock(queue_->audio_queue_mutex);
    queue_->audio_queue.clear();
    queue_->incremental_audio_queue.clear();
    queue_->incremental_audio_queued_bytes = 0;
    queue_->incremental_audio_queued_frames = 0;
    queue_->playback_ack_queue.clear();
    queue_->current_audio_turn_id.clear();
    queue_->current_audio_message_id.clear();
    queue_->current_audio_generation = 0;
    queue_->current_audio_serial = 0;
  }
  queue_->audio_queue_condition.notify_all();
}

void AudioRuntime::NotifyQueueOne() noexcept {
  queue_->audio_queue_condition.notify_one();
}

void AudioRuntime::NotifyQueueAll() noexcept {
  queue_->audio_queue_condition.notify_all();
}

void AudioRuntime::SetCurrentAudio(
    std::string turn_id,
    std::string message_id,
    std::uint64_t generation,
    std::uint64_t serial) {
  std::scoped_lock lock(queue_->audio_queue_mutex);
  queue_->current_audio_turn_id = std::move(turn_id);
  queue_->current_audio_message_id = std::move(message_id);
  queue_->current_audio_generation = generation;
  queue_->current_audio_serial = serial;
}

void AudioRuntime::ClearCurrentAudioIfMatches(
    std::string_view turn_id,
    std::string_view message_id,
    std::uint64_t generation,
    std::uint64_t serial) {
  std::scoped_lock lock(queue_->audio_queue_mutex);
  if (queue_->current_audio_turn_id == turn_id
      && queue_->current_audio_message_id == message_id
      && queue_->current_audio_generation == generation
      && queue_->current_audio_serial == serial) {
    queue_->current_audio_turn_id.clear();
    queue_->current_audio_message_id.clear();
    queue_->current_audio_generation = 0;
    queue_->current_audio_serial = 0;
  }
}

NativeAudioOutput::~NativeAudioOutput() {
  Stop();
}

bool NativeAudioOutput::Start(
    const ag99::audio::PcmWavInfo& info,
    std::vector<std::uint8_t> bytes) {
  Stop();
  if (bytes.empty() || info.data_offset > bytes.size()
      || info.data_size > bytes.size() - info.data_offset
      || info.data_size > MAXDWORD || info.channels == 0
      || info.sample_rate == 0 || info.bits_per_sample == 0
      || info.block_align == 0 || info.byte_rate == 0) {
    return false;
  }

  WAVEFORMATEX format{};
  format.wFormatTag = WAVE_FORMAT_PCM;
  format.nChannels = info.channels;
  format.nSamplesPerSec = info.sample_rate;
  format.nAvgBytesPerSec = info.byte_rate;
  format.nBlockAlign = info.block_align;
  format.wBitsPerSample = info.bits_per_sample;
  MMRESULT result = waveOutOpen(
      &handle_,
      WAVE_MAPPER,
      &format,
      0,
      0,
      CALLBACK_NULL);
  if (result != MMSYSERR_NOERROR) {
    handle_ = nullptr;
    return false;
  }
  SetVolume(volume_);

  bytes_ = std::move(bytes);
  header_ = WAVEHDR{};
  header_.lpData = reinterpret_cast<LPSTR>(
      bytes_.data() + info.data_offset);
  header_.dwBufferLength = static_cast<DWORD>(info.data_size);
  result = waveOutPrepareHeader(
      handle_, &header_, sizeof(header_));
  if (result != MMSYSERR_NOERROR) {
    Stop();
    return false;
  }
  prepared_ = true;
  result = waveOutWrite(handle_, &header_, sizeof(header_));
  if (result != MMSYSERR_NOERROR) {
    Stop();
    return false;
  }
  return true;
}

void NativeAudioOutput::SetVolume(float volume) noexcept {
  volume_ = std::clamp(volume, 0.0f, 1.0f);
  if (handle_) {
    waveOutSetVolume(handle_, VolumeWord(volume_));
  }
}

void NativeAudioOutput::Stop() noexcept {
  if (handle_) {
    waveOutReset(handle_);
    if (prepared_) {
      waveOutUnprepareHeader(handle_, &header_, sizeof(header_));
    }
    waveOutClose(handle_);
    handle_ = nullptr;
  }
  prepared_ = false;
  header_ = WAVEHDR{};
  bytes_.clear();
}

NativePcmStreamOutput::~NativePcmStreamOutput() {
  Stop();
}

bool NativePcmStreamOutput::Start(
  std::uint32_t sample_rate, std::uint16_t channels) {
  Stop();
  if (sample_rate == 0 || channels == 0) {
    return false;
  }
  WAVEFORMATEX format{};
  format.wFormatTag = WAVE_FORMAT_PCM;
  format.nChannels = channels;
  format.nSamplesPerSec = sample_rate;
  format.wBitsPerSample = 16;
  format.nBlockAlign = static_cast<WORD>(channels * sizeof(std::int16_t));
  format.nAvgBytesPerSec = format.nSamplesPerSec * format.nBlockAlign;
  const auto result = waveOutOpen(
      &handle_,
      WAVE_MAPPER,
      &format,
      reinterpret_cast<DWORD_PTR>(&WaveOutProc),
      reinterpret_cast<DWORD_PTR>(this),
      CALLBACK_FUNCTION);
  if (result != MMSYSERR_NOERROR) {
    handle_ = nullptr;
    return false;
  }
  block_align_ = format.nBlockAlign;
  stopping_ = false;
  SetVolume(volume_);
  return true;
}

void NativePcmStreamOutput::SetVolume(float volume) noexcept {
  std::scoped_lock lock(mutex_);
  volume_ = std::clamp(volume, 0.0f, 1.0f);
  if (handle_) {
    waveOutSetVolume(handle_, VolumeWord(volume_));
  }
}

bool NativePcmStreamOutput::Append(std::span<const std::uint8_t> pcm) {
  if (pcm.empty() || pcm.size() > 64 * 1024) {
    return false;
  }
  std::unique_lock lock(mutex_);
  ReapCompletedLocked();
  if (!handle_ || stopping_ || block_align_ == 0
      || pcm.size() % block_align_ != 0) {
    return false;
  }
  const auto deadline = std::chrono::steady_clock::now()
      + std::chrono::seconds(5);
  while (buffers_.size() >= kMaxBuffers && !stopping_) {
    if (condition_.wait_until(lock, deadline) == std::cv_status::timeout) {
      ReapCompletedLocked();
      return false;
    }
    ReapCompletedLocked();
  }
  if (!handle_ || stopping_) {
    return false;
  }
  auto buffer = std::make_shared<Buffer>();
  buffer->bytes.assign(pcm.begin(), pcm.end());
  buffer->header.lpData = reinterpret_cast<LPSTR>(buffer->bytes.data());
  buffer->header.dwBufferLength = static_cast<DWORD>(buffer->bytes.size());
  auto result = waveOutPrepareHeader(
      handle_, &buffer->header, sizeof(buffer->header));
  if (result != MMSYSERR_NOERROR) {
    return false;
  }
  buffer->prepared = true;
  buffers_.push_back(buffer);
  result = waveOutWrite(handle_, &buffer->header, sizeof(buffer->header));
  if (result != MMSYSERR_NOERROR) {
    waveOutUnprepareHeader(handle_, &buffer->header, sizeof(buffer->header));
    buffers_.pop_back();
    return false;
  }
  return true;
}

bool NativePcmStreamOutput::WaitForDrain(
    std::chrono::milliseconds timeout) {
  std::unique_lock lock(mutex_);
  const auto deadline = std::chrono::steady_clock::now() + timeout;
  while (handle_ && !stopping_ && !buffers_.empty()) {
    if (condition_.wait_until(lock, deadline) == std::cv_status::timeout) {
      return false;
    }
    ReapCompletedLocked();
  }
  return !handle_ || buffers_.empty();
}

void NativePcmStreamOutput::Stop() noexcept {
  HWAVEOUT handle = nullptr;
  {
    std::scoped_lock lock(mutex_);
    handle = handle_;
    stopping_ = true;
  }
  if (handle) {
    waveOutReset(handle);
    std::scoped_lock lock(mutex_);
    ReapCompletedLocked();
    for (const auto& buffer : buffers_) {
      if (buffer->prepared) {
        waveOutUnprepareHeader(handle, &buffer->header, sizeof(buffer->header));
        buffer->prepared = false;
      }
    }
    buffers_.clear();
    waveOutClose(handle);
    handle_ = nullptr;
  }
  std::scoped_lock lock(mutex_);
  block_align_ = 2;
  stopping_ = false;
}

void CALLBACK NativePcmStreamOutput::WaveOutProc(
    HWAVEOUT,
    UINT message,
    DWORD_PTR instance,
    DWORD_PTR parameter,
    DWORD_PTR) {
  if (message != WOM_DONE || instance == 0 || parameter == 0) {
    return;
  }
  auto* self = reinterpret_cast<NativePcmStreamOutput*>(instance);
  self->OnBufferDone(reinterpret_cast<WAVEHDR*>(parameter));
}

void NativePcmStreamOutput::OnBufferDone(WAVEHDR* header) {
  std::scoped_lock lock(mutex_);
  for (const auto& buffer : buffers_) {
    if (&buffer->header == header) {
      buffer->completed = true;
      break;
    }
  }
  condition_.notify_all();
}

void NativePcmStreamOutput::ReapCompletedLocked() {
  for (auto it = buffers_.begin(); it != buffers_.end();) {
    if (!(*it)->completed) {
      ++it;
      continue;
    }
    if ((*it)->prepared && handle_) {
      waveOutUnprepareHeader(
          handle_, &(*it)->header, sizeof((*it)->header));
    }
    it = buffers_.erase(it);
  }
}
}  // namespace ag99::native
