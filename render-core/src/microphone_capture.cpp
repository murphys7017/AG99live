#include <windows.h>
#include <mmsystem.h>

#include <algorithm>
#include <cstdint>
#include <charconv>
#include <exception>
#include <iostream>
#include <system_error>
#include <span>
#include <string>
#include <utility>

#include "ag99/native/microphone_capture.hpp"
#include "ag99/runtime/protocol.hpp"
#include "ag99/runtime/winhttp_websocket.hpp"

#include <optional>

namespace ag99::native {
MicrophoneCapture::MicrophoneCapture(
  ag99::runtime::WinHttpWebSocketClient& websocket)
    : websocket_(websocket) {}

MicrophoneCapture::~MicrophoneCapture() {
  Stop("runtime_shutdown");
}

bool MicrophoneCapture::Start() {
  if (running_.load()) {
    return false;
  }
  bool previous_stream_active = false;
  bool previous_send_failed = false;
  {
    std::scoped_lock lock(queue_mutex_);
    previous_stream_active = running_stream_active_;
    previous_send_failed = send_failed_;
  }
  if (previous_stream_active) {
    Stop(previous_send_failed ? "audio_sender_failed" : "capture_restarted");
  }
  if (!websocket_.connected()) {
    return false;
  }
  if (audio_worker_.joinable()) {
    audio_worker_.join();
  }

  const auto serial = next_stream_serial_.fetch_add(1);
  {
    std::scoped_lock lock(queue_mutex_);
    stream_id_ = "native-mic-" + std::to_string(serial);
    turn_id_ = stream_id_;
    sequence_ = 0;
    pending_frames_.clear();
    dropped_bytes_ = 0;
    send_failed_ = false;
  }

  WAVEFORMATEX format{};
  format.wFormatTag = WAVE_FORMAT_PCM;
  format.nChannels = 1;
  format.nSamplesPerSec = 16000;
  format.wBitsPerSample = 16;
  format.nBlockAlign = format.nChannels * format.wBitsPerSample / 8;
  format.nAvgBytesPerSec = format.nSamplesPerSec * format.nBlockAlign;
  format.cbSize = 0;

  HWAVEIN device = nullptr;
  const auto selected_device = SelectedDeviceId();
  const auto open_result = waveInOpen(
      &device,
      selected_device,
      &format,
      reinterpret_cast<DWORD_PTR>(&WaveInCallback),
      reinterpret_cast<DWORD_PTR>(this),
      CALLBACK_FUNCTION);
  if (open_result != MMSYSERR_NOERROR) {
    return false;
  }
  device_.store(device);

  for (auto& buffer : buffers_) {
    buffer.assign(kBufferBytes, 0);
  }
  for (auto& header : headers_) {
    header = {};
  }
  for (std::size_t index = 0; index < buffers_.size(); ++index) {
    auto& header = headers_[index];
    header.lpData = reinterpret_cast<LPSTR>(buffers_[index].data());
    header.dwBufferLength = static_cast<DWORD>(buffers_[index].size());
    if (waveInPrepareHeader(device, &header, sizeof(header))
        != MMSYSERR_NOERROR) {
      CloseDevice();
      return false;
    }
    prepared_[index] = true;
    if (waveInAddBuffer(device, &header, sizeof(header))
        != MMSYSERR_NOERROR) {
      CloseDevice();
      return false;
    }
  }

  const std::string stream_id = StreamId();
  const std::string turn_id = TurnId();
  const auto start_message = ag99::runtime::build_input_audio_stream_start(
      stream_id,
      "microphone",
      16000,
      1,
      "manual",
      std::nullopt,
      turn_id);
  if (!websocket_.send_text(start_message.dump())) {
    CloseDevice();
    return false;
  }

  audio_worker_ = std::thread([this] { AudioSenderLoop(); });
  {
    std::scoped_lock lock(queue_mutex_);
    running_stream_active_ = true;
  }
  running_.store(true);
  if (waveInStart(device) != MMSYSERR_NOERROR) {
    Stop("capture_device_start_failed");
    return false;
  }
  return true;
}

// Never call this from the waveIn driver callback: CloseDevice runs
// waveInReset, which waits for that callback to drain.
void MicrophoneCapture::Stop(std::string_view reason) {
  running_.store(false);
  {
    // Released before joining: the sender thread may be inside CloseDevice
    // and needs this same lock to finish.
    std::scoped_lock stop_lock(stop_mutex_);
    CloseDevice();
  }
  queue_condition_.notify_all();
  {
    // Serialises concurrent Stop callers so only one of them joins.
    std::scoped_lock join_lock(join_mutex_);
    if (audio_worker_.joinable()) {
      audio_worker_.join();
    }
  }

  std::string stream_id;
  std::optional<std::uint64_t> last_sequence;
  std::uint64_t dropped_bytes = 0;
  bool dropped = false;
  {
    std::scoped_lock queue_lock(queue_mutex_);
    if (running_stream_active_) {
      stream_id = stream_id_;
      last_sequence = sequence_ == 0
          ? std::nullopt
          : std::optional<std::uint64_t>{sequence_ - 1};
    }
    running_stream_active_ = false;
    dropped_bytes = dropped_bytes_;
    dropped = dropped_bytes_ > 0 || send_failed_;
    dropped_bytes_ = 0;
    send_failed_ = false;
    stream_id_.clear();
    turn_id_.clear();
    sequence_ = 0;
    pending_frames_.clear();
  }
  if (dropped_bytes > 0) {
    std::cerr << "[microphone] dropped " << dropped_bytes
              << " captured bytes while sending\n";
  }
  if (stream_id.empty() || !websocket_.connected()) {
    return;
  }
  const auto end_message = ag99::runtime::build_input_audio_stream_end(
      stream_id,
      reason,
      dropped,
      last_sequence,
      "manual");
  websocket_.send_text(end_message.dump());
}

bool MicrophoneCapture::running() const noexcept {
  return running_.load();
}

ag99::runtime::DesktopSettingsResult MicrophoneCapture::HandleDeviceSetting(
    const ag99::runtime::DesktopSettingsQuery& query) {
  ag99::runtime::DesktopSettingsResult result{
      query.request_id,
      query.key,
      std::nullopt,
      {}};
  const auto options = EnumerateDevices();
  if (query.action == "set") {
    const auto requested = query.value.value_or("");
    const bool available = requested == "default"
        || std::any_of(options.begin(), options.end(), [&](const auto& option) {
             return option.id == requested;
           });
    if (!available) {
      result.error = "desktop_setting_value_not_available";
      return result;
    }
    const bool was_running = running_.load();
    std::string previous_device;
    {
      std::scoped_lock lock(queue_mutex_);
      previous_device = device_id_;
    }
    if (was_running) {
      Stop("microphone_device_changed");
    }
    {
      std::scoped_lock lock(queue_mutex_);
      device_id_ = requested;
    }
    if (was_running && !Start()) {
      {
        std::scoped_lock lock(queue_mutex_);
        device_id_ = std::move(previous_device);
      }
      Start();
      result.error = "desktop_setting_failed";
      return result;
    }
  }
  std::string current;
  {
    std::scoped_lock lock(queue_mutex_);
    current = device_id_;
  }
  result.entry = ag99::runtime::DesktopSettingsEntry{
      current,
      options,
      std::nullopt,
      std::nullopt,
      std::nullopt};
  return result;
}

void CALLBACK MicrophoneCapture::WaveInCallback(
    HWAVEIN,
    UINT message,
    DWORD_PTR instance,
    DWORD_PTR parameter1,
    DWORD_PTR) {
  if (message != WIM_DATA || instance == 0 || parameter1 == 0) {
    return;
  }
  auto* capture = reinterpret_cast<MicrophoneCapture*>(instance);
  capture->OnBuffer(reinterpret_cast<WAVEHDR*>(parameter1));
}

// Driver callback: copy, re-arm, return. No allocation-heavy work, no
// network I/O, and never a device teardown from this thread.
void MicrophoneCapture::OnBuffer(WAVEHDR* header) {
  if (!running_.load() || !header || header->dwBytesRecorded == 0) {
    return;
  }
  {
    std::scoped_lock lock(queue_mutex_);
    if (!running_.load()) {
      return;
    }
    if (pending_frames_.size() >= kMaxQueuedFrames) {
      dropped_bytes_ += header->dwBytesRecorded;
    } else {
      pending_frames_.emplace_back(
          reinterpret_cast<const std::uint8_t*>(header->lpData),
          reinterpret_cast<const std::uint8_t*>(header->lpData)
              + header->dwBytesRecorded);
    }
  }
  queue_condition_.notify_one();

  header->dwBytesRecorded = 0;
  const HWAVEIN device = device_.load();
  if (device) {
    waveInAddBuffer(device, header, sizeof(WAVEHDR));
  }
}

void MicrophoneCapture::AudioSenderLoop() {
  while (true) {
    std::vector<std::uint8_t> payload;
    ag99::runtime::AudioChunkMetadata metadata{};
    {
      std::unique_lock lock(queue_mutex_);
      queue_condition_.wait(lock, [this] {
        return !pending_frames_.empty() || !running_.load();
      });
      if (pending_frames_.empty()) {
        return;
      }
      payload = std::move(pending_frames_.front());
      pending_frames_.pop_front();
      metadata = ag99::runtime::AudioChunkMetadata{
          stream_id_,
          turn_id_,
          sequence_++,
          "pcm16le",
          16000,
          1,
          "manual"};
    }
    if (metadata.stream_id.empty()) {
      continue;
    }
    try {
      const auto frame = ag99::runtime::build_binary_audio_frame(
          metadata, std::span<const std::uint8_t>(payload));
      if (!websocket_.send_binary(frame)) {
        throw std::runtime_error("audio_frame_send_failed");
      }
    } catch (const std::exception& error) {
      std::cerr << "[microphone] audio frame send failed: "
                << error.what() << '\n';
      // Never call Stop() from this thread: it joins this thread. Tear the
      // device down here (safe, we are not the driver callback) and let the
      // main thread run the full stop when it next does.
      running_.store(false);
      {
        std::scoped_lock lock(queue_mutex_);
        send_failed_ = true;
        dropped_bytes_ += payload.size();
        for (const auto& queued : pending_frames_) {
          dropped_bytes_ += queued.size();
        }
        pending_frames_.clear();
      }
      queue_condition_.notify_all();
      CloseDevice();
      return;
    }
  }
}

// Must run off the driver callback. stop_mutex_ serialises callers and is
// recursive because Stop() calls into this.
void MicrophoneCapture::CloseDevice() {
  std::scoped_lock lock(stop_mutex_);
  const HWAVEIN device = device_.exchange(nullptr);
  if (!device) {
    return;
  }
  waveInStop(device);
  waveInReset(device);
  for (std::size_t index = 0; index < headers_.size(); ++index) {
    if (prepared_[index]) {
      waveInUnprepareHeader(device, &headers_[index], sizeof(WAVEHDR));
      prepared_[index] = false;
    }
  }
  waveInClose(device);
}

std::vector<ag99::runtime::DesktopSettingOption>
MicrophoneCapture::EnumerateDevices() {
  std::vector<ag99::runtime::DesktopSettingOption> options;
  const auto count = waveInGetNumDevs();
  options.reserve(count + 1);
  options.push_back({"default", "系统默认"});
  for (UINT index = 0; index < count; ++index) {
    WAVEINCAPSW caps{};
    if (waveInGetDevCapsW(index, &caps, sizeof(caps)) != MMSYSERR_NOERROR) {
      continue;
    }
    const auto label = WideToUtf8(caps.szPname);
    options.push_back({std::to_string(index), label.empty()
        ? "Microphone " + std::to_string(index + 1) : label});
  }
  return options;
}

std::string MicrophoneCapture::WideToUtf8(const wchar_t* value) {
  if (!value || !*value) {
    return {};
  }
  const int length = WideCharToMultiByte(
      CP_UTF8,
      WC_ERR_INVALID_CHARS,
      value,
      -1,
      nullptr,
      0,
      nullptr,
      nullptr);
  if (length <= 1) {
    return {};
  }
  std::string result(static_cast<std::size_t>(length - 1), '\0');
  WideCharToMultiByte(
      CP_UTF8,
      WC_ERR_INVALID_CHARS,
      value,
      -1,
      result.data(),
      length - 1,
      nullptr,
      nullptr);
  return result;
}

UINT MicrophoneCapture::SelectedDeviceId() const {
  std::string selected;
  {
    std::scoped_lock lock(queue_mutex_);
    selected = device_id_;
  }
  if (selected.empty() || selected == "default") {
    return WAVE_MAPPER;
  }
  UINT device = WAVE_MAPPER;
  const auto parsed = std::from_chars(
      selected.data(), selected.data() + selected.size(), device);
  return parsed.ec == std::errc{} && parsed.ptr == selected.data() + selected.size()
      ? device : WAVE_MAPPER;
}

std::string MicrophoneCapture::StreamId() const {
  std::scoped_lock lock(queue_mutex_);
  return stream_id_;
}

std::string MicrophoneCapture::TurnId() const {
  std::scoped_lock lock(queue_mutex_);
  return turn_id_;
}
}  // namespace ag99::native
