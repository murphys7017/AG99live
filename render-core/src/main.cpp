#include <windows.h>
#include <dwmapi.h>
#include <d3d11.h>
#include <dxgi.h>
#include <mmsystem.h>
#include <shellapi.h>
#include <winhttp.h>
#include <windowsx.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <functional>
#include <iostream>
#include <malloc.h>
#include <mutex>
#include <optional>
#include <string>
#include <string_view>
#include <thread>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include "ag99/runtime/protocol.hpp"
#include "ag99/runtime/runtime_session.hpp"
#include "ag99/runtime/winhttp_websocket.hpp"
#include <CubismFramework.hpp>
#include <CubismModelSettingJson.hpp>
#include <Id/CubismIdManager.hpp>
#include <Model/CubismUserModel.hpp>
#include <Motion/ACubismMotion.hpp>
#include <Rendering/D3D11/CubismDeviceInfo_D3D11.hpp>
#include <Rendering/D3D11/CubismRenderer_D3D11.hpp>
#include <WICTextureLoader.h>

namespace {

using namespace Live2D::Cubism::Framework;

constexpr wchar_t kWindowClassName[] = L"AG99liveRenderCoreWindow";
constexpr wchar_t kWindowTitle[] = L"AG99live Native Render Core";
constexpr UINT kTrayMessage = WM_APP + 1;
constexpr UINT kTrayShow = 1001;
constexpr UINT kTrayHide = 1002;
constexpr UINT kTrayExit = 1003;
constexpr UINT kTrayDemoText = 1004;
constexpr UINT kTrayMicToggle = 1005;

HWND g_window = nullptr;
NOTIFYICONDATAW g_tray_icon{};
bool g_tray_icon_added = false;
bool g_dragging = false;
POINT g_drag_cursor{};
POINT g_drag_origin{};
std::atomic<double> g_audio_end_seconds{0.0};
std::atomic<double> g_audio_start_seconds{0.0};
std::atomic<float> g_audio_level{0.0f};
std::atomic<bool> g_talk_motion_requested{false};
std::atomic<std::uint64_t> g_audio_serial{0};
std::mutex g_audio_file_mutex;
std::mutex g_audio_signal_mutex;
std::wstring g_audio_file;
std::vector<float> g_audio_rms;
std::function<void(std::string)> g_send_text;
std::function<void()> g_toggle_microphone;
std::function<bool()> g_microphone_running;

double NowSeconds() {
  return std::chrono::duration<double>(
      std::chrono::steady_clock::now().time_since_epoch()).count();
}

void UpdateAudioLevel() {
  const double now = NowSeconds();
  const double remaining = g_audio_end_seconds.load() - now;
  if (remaining <= 0.0) {
    g_audio_level.store(0.0f);
    return;
  }
  const double elapsed = std::max(0.0, now - g_audio_start_seconds.load());
  float level = 0.0f;
  {
    std::scoped_lock lock(g_audio_signal_mutex);
    const auto index = static_cast<std::size_t>(elapsed * 50.0);
    if (index < g_audio_rms.size()) {
      level = std::clamp(g_audio_rms[index] * 4.0f, 0.0f, 1.0f);
    }
  }
  g_audio_level.store(level);
}

std::wstring WidenUtf8(std::string_view value) {
  if (value.empty()) {
    return {};
  }
  const int length = MultiByteToWideChar(
      CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
      static_cast<int>(value.size()), nullptr, 0);
  if (length <= 0) {
    return {};
  }
  std::wstring result(static_cast<std::size_t>(length), L'\0');
  MultiByteToWideChar(
      CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
      static_cast<int>(value.size()), result.data(), length);
  return result;
}

bool DownloadHttp(const std::string& url, std::vector<std::uint8_t>& output) {
  const std::wstring wide_url = WidenUtf8(url);
  if (wide_url.empty()) {
    return false;
  }

  URL_COMPONENTS components{};
  components.dwStructSize = sizeof(components);
  wchar_t host[256]{};
  wchar_t path[2048]{};
  wchar_t extra[2048]{};
  components.lpszHostName = host;
  components.dwHostNameLength = std::size(host);
  components.lpszUrlPath = path;
  components.dwUrlPathLength = std::size(path);
  components.lpszExtraInfo = extra;
  components.dwExtraInfoLength = std::size(extra);
  if (!WinHttpCrackUrl(
          wide_url.c_str(), static_cast<DWORD>(wide_url.size()), 0,
          &components)) {
    return false;
  }

  HINTERNET session = WinHttpOpen(
      L"AG99liveNativeDemo/0.1", WINHTTP_ACCESS_TYPE_DEFAULT_PROXY,
      WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
  if (!session) {
    return false;
  }
  HINTERNET connection = WinHttpConnect(
      session, components.lpszHostName, components.nPort, 0);
  const DWORD flags = components.nScheme == INTERNET_SCHEME_HTTPS
      ? WINHTTP_FLAG_SECURE : 0;
  const std::wstring object = std::wstring(path) + extra;
  HINTERNET request = connection
      ? WinHttpOpenRequest(connection, L"GET", object.c_str(), nullptr,
                           WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES,
                           flags)
      : nullptr;
  bool success = false;
  if (request &&
      WinHttpSendRequest(request, WINHTTP_NO_ADDITIONAL_HEADERS, 0,
                         WINHTTP_NO_REQUEST_DATA, 0, 0, 0) &&
      WinHttpReceiveResponse(request, nullptr)) {
    std::uint8_t buffer[64 * 1024];
    DWORD read = 0;
    do {
      if (!WinHttpReadData(request, buffer, sizeof(buffer), &read)) {
        output.clear();
        break;
      }
      output.insert(output.end(), buffer, buffer + read);
    } while (read != 0);
    success = !output.empty();
  }
  if (request) {
    WinHttpCloseHandle(request);
  }
  if (connection) {
    WinHttpCloseHandle(connection);
  }
  WinHttpCloseHandle(session);
  return success;
}

std::optional<double> ReadWavDuration(const std::vector<std::uint8_t>& bytes) {
  if (bytes.size() < 44 || std::memcmp(bytes.data(), "RIFF", 4) != 0 ||
      std::memcmp(bytes.data() + 8, "WAVE", 4) != 0) {
    return std::nullopt;
  }
  std::uint32_t byte_rate = 0;
  std::uint32_t data_size = 0;
  for (std::size_t offset = 12; offset + 8 <= bytes.size();) {
    const std::uint32_t chunk_size =
        *reinterpret_cast<const std::uint32_t*>(bytes.data() + offset + 4);
    if (std::memcmp(bytes.data() + offset, "fmt ", 4) == 0 &&
        chunk_size >= 12 && offset + 8 + chunk_size <= bytes.size()) {
      byte_rate = *reinterpret_cast<const std::uint32_t*>(
          bytes.data() + offset + 8 + 8);
    } else if (std::memcmp(bytes.data() + offset, "data", 4) == 0) {
      data_size = std::min<std::uint32_t>(
          chunk_size, static_cast<std::uint32_t>(
              bytes.size() - std::min(bytes.size(), offset + 8)));
      break;
    }
    offset += 8 + chunk_size + (chunk_size & 1u);
  }
  if (byte_rate == 0 || data_size == 0) {
    return std::nullopt;
  }
  return static_cast<double>(data_size) / byte_rate;
}

std::vector<float> ReadWavRms(const std::vector<std::uint8_t>& bytes) {
  if (bytes.size() < 44 || std::memcmp(bytes.data(), "RIFF", 4) != 0
      || std::memcmp(bytes.data() + 8, "WAVE", 4) != 0) {
    return {};
  }
  std::uint16_t format = 0;
  std::uint16_t channels = 0;
  std::uint32_t sample_rate = 0;
  std::uint16_t bits_per_sample = 0;
  std::size_t data_offset = 0;
  std::size_t data_size = 0;
  auto read_u16 = [&bytes](std::size_t offset) {
    std::uint16_t value = 0;
    std::memcpy(&value, bytes.data() + offset, sizeof(value));
    return value;
  };
  auto read_u32 = [&bytes](std::size_t offset) {
    std::uint32_t value = 0;
    std::memcpy(&value, bytes.data() + offset, sizeof(value));
    return value;
  };
  for (std::size_t offset = 12; offset + 8 <= bytes.size();) {
    const auto chunk_size = static_cast<std::size_t>(read_u32(offset + 4));
    const auto chunk_start = offset + 8;
    if (chunk_start > bytes.size()
        || chunk_size > bytes.size() - chunk_start) {
      break;
    }
    if (std::memcmp(bytes.data() + offset, "fmt ", 4) == 0
        && chunk_size >= 16) {
      format = read_u16(chunk_start);
      channels = read_u16(chunk_start + 2);
      sample_rate = read_u32(chunk_start + 4);
      bits_per_sample = read_u16(chunk_start + 14);
    } else if (std::memcmp(bytes.data() + offset, "data", 4) == 0) {
      data_offset = chunk_start;
      data_size = chunk_size;
      break;
    }
    offset = chunk_start + chunk_size + (chunk_size & 1u);
  }
  if (format != 1 || channels == 0 || sample_rate == 0
      || bits_per_sample != 16 || data_offset == 0 || data_size == 0) {
    return {};
  }
  const std::size_t bytes_per_frame = static_cast<std::size_t>(channels) * 2;
  const std::size_t frame_count = data_size / bytes_per_frame;
  const std::size_t frames_per_bucket =
      std::max<std::size_t>(1, sample_rate / 50);
  std::vector<float> result;
  result.reserve((frame_count + frames_per_bucket - 1) / frames_per_bucket);
  for (std::size_t first = 0; first < frame_count; first += frames_per_bucket) {
    const std::size_t count = std::min(frames_per_bucket, frame_count - first);
    double square_sum = 0.0;
    for (std::size_t frame = 0; frame < count; ++frame) {
      for (std::size_t channel = 0; channel < channels; ++channel) {
        const auto offset = data_offset
            + (first + frame) * bytes_per_frame + channel * 2;
        std::int16_t sample = 0;
        std::memcpy(&sample, bytes.data() + offset, sizeof(sample));
        const double normalized = static_cast<double>(sample) / 32768.0;
        square_sum += normalized * normalized;
      }
    }
    const double sample_count = static_cast<double>(count) * channels;
    result.push_back(static_cast<float>(
        std::sqrt(square_sum / std::max(1.0, sample_count))));
  }
  return result;
}

std::optional<std::wstring> WriteTempAudio(
    const std::vector<std::uint8_t>& bytes) {
  wchar_t temp_directory[MAX_PATH]{};
  wchar_t temp_file[MAX_PATH]{};
  if (!GetTempPathW(std::size(temp_directory), temp_directory) ||
      !GetTempFileNameW(temp_directory, L"ag9", 0, temp_file)) {
    return std::nullopt;
  }
  FILE* file = nullptr;
  if (_wfopen_s(&file, temp_file, L"wb") != 0 || !file) {
    DeleteFileW(temp_file);
    return std::nullopt;
  }
  const bool written = fwrite(bytes.data(), 1, bytes.size(), file) == bytes.size();
  fclose(file);
  if (!written) {
    DeleteFileW(temp_file);
    return std::nullopt;
  }
  return std::wstring(temp_file);
}

void StopCurrentAudio() {
  std::scoped_lock lock(g_audio_file_mutex);
  g_audio_serial.fetch_add(1);
  PlaySoundW(nullptr, nullptr, 0);
  if (!g_audio_file.empty()) {
    DeleteFileW(g_audio_file.c_str());
    g_audio_file.clear();
  }
  g_audio_end_seconds.store(0.0);
  g_audio_start_seconds.store(0.0);
  g_audio_level.store(0.0f);
  {
    std::scoped_lock signal_lock(g_audio_signal_mutex);
    g_audio_rms.clear();
  }
}

struct AudioPlayback {
  double duration_seconds = 0.0;
  std::uint64_t serial = 0;
};

std::optional<AudioPlayback> PlayAudioUrl(const std::string& url) {
  std::vector<std::uint8_t> bytes;
  if (!DownloadHttp(url, bytes)) {
    std::cerr << "Failed to download audio: " << url << '\n';
    return std::nullopt;
  }
  const auto path = WriteTempAudio(bytes);
  if (!path) {
    return std::nullopt;
  }
  const double duration = ReadWavDuration(bytes).value_or(1.0);
  const auto rms = ReadWavRms(bytes);
  const auto serial = g_audio_serial.fetch_add(1) + 1;
  {
    std::scoped_lock lock(g_audio_file_mutex);
    PlaySoundW(nullptr, nullptr, 0);
    if (!g_audio_file.empty()) {
      DeleteFileW(g_audio_file.c_str());
    }
    g_audio_file = *path;
    PlaySoundW(g_audio_file.c_str(), nullptr, SND_FILENAME | SND_ASYNC | SND_NODEFAULT);
  }
  {
    std::scoped_lock signal_lock(g_audio_signal_mutex);
    g_audio_rms = rms;
  }
  g_audio_start_seconds.store(NowSeconds());
  g_audio_end_seconds.store(g_audio_start_seconds.load() + duration);
  g_talk_motion_requested.store(true);
  return AudioPlayback{duration, serial};
}

class Allocator final : public ICubismAllocator {
public:
  void* Allocate(const csmSizeType size) override {
    return std::malloc(size);
  }

  void Deallocate(void* memory) override {
    std::free(memory);
  }

  void* AllocateAligned(const csmSizeType size, const csmUint32 alignment) override {
    return _aligned_malloc(size, std::max<csmUint32>(alignment, 1));
  }

  void DeallocateAligned(void* memory) override {
    _aligned_free(memory);
  }
};

Allocator g_allocator;
ID3D11Device* g_device = nullptr;
ID3D11DeviceContext* g_context = nullptr;
IDXGISwapChain* g_swap_chain = nullptr;
ID3D11RenderTargetView* g_render_target = nullptr;

#ifndef AG99_CUBISM_SHADER_DIR
#define AG99_CUBISM_SHADER_DIR ""
#endif

const std::filesystem::path g_shader_directory = AG99_CUBISM_SHADER_DIR;

struct TextureResource {
  ID3D11Resource* resource = nullptr;
  ID3D11ShaderResourceView* view = nullptr;
};

void LogMessage(const csmChar* message) {
  if (message) {
    std::cerr << "[cubism] " << message << '\n';
  }
}

bool ReadFile(const std::filesystem::path& path, std::vector<csmByte>& output);

class NativeCubismModel final : public CubismUserModel {
public:
  ~NativeCubismModel() override {
    if (_idle_motion) {
      ACubismMotion::Delete(_idle_motion);
    }
    if (_talk_motion) {
      ACubismMotion::Delete(_talk_motion);
    }
  }

  bool LoadDemoMotions(
      const std::filesystem::path& model_directory,
      CubismModelSettingJson* setting) {
    _idle_motion = LoadDemoMotion(
        model_directory, setting, "Idle", 0, "idle");
    _talk_motion = LoadDemoMotion(
        model_directory, setting, "Talk", 0, "talk");
    if (!_idle_motion) {
      std::cerr << "[cubism] no Idle/0 motion was available\n";
    }
    if (!_talk_motion) {
      std::cerr << "[cubism] no Talk/0 motion was available\n";
    }
    return _idle_motion != nullptr || _talk_motion != nullptr;
  }

  void StartTalkMotion() {
    if (_motionManager && _talk_motion) {
      _motionManager->StartMotionPriority(_talk_motion, false, 2);
    }
  }

  void UpdateMotion(csmFloat32 delta_seconds) {
    if (!_motionManager || !_model) {
      return;
    }

    _model->LoadParameters();
    if (_motionManager->IsFinished()) {
      if (g_audio_end_seconds.load() > NowSeconds() && _talk_motion) {
        _motionManager->StartMotionPriority(_talk_motion, false, 2);
      } else if (_idle_motion) {
        _motionManager->StartMotionPriority(_idle_motion, false, 1);
      }
    } else {
      _motionManager->UpdateMotion(_model, delta_seconds);
    }
    _model->SaveParameters();
  }

private:
  ACubismMotion* LoadDemoMotion(
      const std::filesystem::path& model_directory,
      CubismModelSettingJson* setting,
      const csmChar* group,
      csmInt32 index,
      const char* label) {
    if (!setting || setting->GetMotionCount(group) <= index) {
      return nullptr;
    }

    const char* file_name = setting->GetMotionFileName(group, index);
    if (!file_name || file_name[0] == '\0') {
      return nullptr;
    }
    const auto motion_path = model_directory / file_name;
    std::vector<csmByte> motion_bytes;
    if (!ReadFile(motion_path, motion_bytes)) {
      std::cerr << "[cubism] failed to read " << label
                << " motion: " << motion_path.string() << '\n';
      return nullptr;
    }
    return LoadMotion(
        motion_bytes.data(),
        static_cast<csmSizeInt>(motion_bytes.size()),
        nullptr,
        nullptr,
        nullptr,
        setting,
        group,
        index);
  }

  ACubismMotion* _idle_motion = nullptr;
  ACubismMotion* _talk_motion = nullptr;
};

class MicrophoneCapture final {
public:
  explicit MicrophoneCapture(
      ag99::runtime::WinHttpWebSocketClient& websocket)
      : websocket_(websocket) {}

  ~MicrophoneCapture() {
    Stop("runtime_shutdown");
  }

  bool Start() {
    if (running_.load() || !websocket_.connected()) {
      return false;
    }

    const auto serial = next_stream_serial_.fetch_add(1);
    stream_id_ = "native-mic-" + std::to_string(serial);
    turn_id_ = stream_id_;
    sequence_ = 0;

    WAVEFORMATEX format{};
    format.wFormatTag = WAVE_FORMAT_PCM;
    format.nChannels = 1;
    format.nSamplesPerSec = 16000;
    format.wBitsPerSample = 16;
    format.nBlockAlign = format.nChannels * format.wBitsPerSample / 8;
    format.nAvgBytesPerSec = format.nSamplesPerSec * format.nBlockAlign;
    format.cbSize = 0;

    const auto open_result = waveInOpen(
        &device_,
        WAVE_MAPPER,
        &format,
        reinterpret_cast<DWORD_PTR>(&WaveInCallback),
        reinterpret_cast<DWORD_PTR>(this),
        CALLBACK_FUNCTION);
    if (open_result != MMSYSERR_NOERROR) {
      device_ = nullptr;
      return false;
    }

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
      if (waveInPrepareHeader(device_, &header, sizeof(header))
          != MMSYSERR_NOERROR) {
        Stop("capture_setup_failed");
        return false;
      }
      prepared_[index] = true;
      if (waveInAddBuffer(device_, &header, sizeof(header))
          != MMSYSERR_NOERROR) {
        Stop("capture_setup_failed");
        return false;
      }
    }

    const auto start_message = ag99::runtime::build_input_audio_stream_start(
        stream_id_,
        "microphone",
        16000,
        1,
        "manual",
        std::nullopt,
        turn_id_);
    if (!websocket_.send_text(start_message.dump())) {
      Stop("capture_start_send_failed");
      return false;
    }

    running_.store(true);
    if (waveInStart(device_) != MMSYSERR_NOERROR) {
      Stop("capture_device_start_failed");
      return false;
    }
    return true;
  }

  void Stop(std::string_view reason) {
    const bool was_running = running_.exchange(false);
    if (device_) {
      waveInStop(device_);
      waveInReset(device_);
      for (std::size_t index = 0; index < headers_.size(); ++index) {
        if (prepared_[index]) {
          waveInUnprepareHeader(device_, &headers_[index], sizeof(WAVEHDR));
          prepared_[index] = false;
        }
      }
      waveInClose(device_);
      device_ = nullptr;
    }

    if (was_running && !stream_id_.empty() && websocket_.connected()) {
      const auto last_sequence = sequence_ == 0
          ? std::optional<std::uint64_t>{}
          : std::optional<std::uint64_t>{sequence_ - 1};
      const auto end_message = ag99::runtime::build_input_audio_stream_end(
          stream_id_,
          reason,
          false,
          last_sequence,
          "manual");
      websocket_.send_text(end_message.dump());
    }
    stream_id_.clear();
    turn_id_.clear();
  }

  bool running() const noexcept {
    return running_.load();
  }

private:
  static constexpr std::size_t kBufferCount = 4;
  static constexpr std::size_t kBufferBytes = 3200;

  static void CALLBACK WaveInCallback(
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

  void OnBuffer(WAVEHDR* header) {
    if (!running_.load() || !header || header->dwBytesRecorded == 0) {
      return;
    }

    const auto payload = std::span<const std::uint8_t>(
        reinterpret_cast<const std::uint8_t*>(header->lpData),
        header->dwBytesRecorded);
    const ag99::runtime::AudioChunkMetadata metadata{
        stream_id_,
        turn_id_,
        sequence_++,
        "pcm16le",
        16000,
        1,
        "manual"};
    try {
      const auto frame = ag99::runtime::build_binary_audio_frame(
          metadata, payload);
      websocket_.send_binary(frame);
    } catch (const std::exception& error) {
      std::cerr << "[microphone] failed to build audio frame: "
                << error.what() << '\n';
      Stop("capture_frame_failed");
      return;
    }
    header->dwBytesRecorded = 0;
    waveInAddBuffer(device_, header, sizeof(WAVEHDR));
  }

  ag99::runtime::WinHttpWebSocketClient& websocket_;
  HWAVEIN device_ = nullptr;
  std::array<std::vector<std::uint8_t>, kBufferCount> buffers_{};
  std::array<WAVEHDR, kBufferCount> headers_{};
  std::array<bool, kBufferCount> prepared_{};
  std::atomic<bool> running_{false};
  std::string stream_id_;
  std::string turn_id_;
  std::uint64_t sequence_ = 0;
  std::atomic<std::uint64_t> next_stream_serial_{1};
};

class RuntimeBridge final {
public:
  RuntimeBridge(
      std::function<void(ag99::runtime::ModelSync)> on_model_sync,
      std::function<void(const ag99::runtime::Json&)> on_motion_intent)
      : microphone_(websocket_),
        on_model_sync_(std::move(on_model_sync)),
        on_motion_intent_(std::move(on_motion_intent)),
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
        }) {}

  bool Connect(const std::string& url) {
    closing_.store(false);
    return websocket_.connect(
        url,
        {
            [this](std::string text) { session_.ingest_text(text); },
            [this](std::vector<std::uint8_t> binary) {
              session_.ingest_binary(binary);
            },
            [](std::string error) {
              std::cerr << "[runtime] websocket error: " << error << '\n';
            },
            [] {
              std::cerr << "[runtime] websocket closed\n";
            },
        });
  }

  bool SendText(std::string_view text) {
    if (text.empty()) {
      return false;
    }
    const auto turn_id = "native-demo-" +
        std::to_string(next_turn_id_.fetch_add(1));
    const auto envelope = ag99::runtime::build_input_text(text, {}, turn_id);
    return websocket_.send_text(envelope.dump());
  }

  bool ToggleMicrophone() {
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

  void Close() {
    closing_.store(true);
    microphone_.Stop("runtime_shutdown");
    websocket_.close();
    std::vector<std::thread> workers;
    {
      std::scoped_lock lock(worker_mutex_);
      workers.swap(audio_workers_);
    }
    for (auto& worker : workers) {
      if (worker.joinable()) {
        worker.join();
      }
    }
    StopCurrentAudio();
  }

private:
  void OnSegment(ag99::runtime::OutputSegment segment) {
    if (segment.motion.state == ag99::runtime::MotionSlot::State::Present
        && on_motion_intent_) {
      on_motion_intent_(segment.motion.payload);
    }
    if (segment.text.state == ag99::runtime::TextSlot::State::Present) {
      std::cout << "[assistant] " << segment.text.content << '\n';
    }
    const auto turn_id = segment.envelope.turn_id.value_or("");
    if (segment.audio.state == ag99::runtime::AudioSlot::State::Present) {
      std::scoped_lock lock(worker_mutex_);
      audio_workers_.emplace_back([this, url = std::move(segment.audio.url), turn_id] {
        const auto playback = PlayAudioUrl(url);
        if (!playback) {
          if (!closing_.load() && !turn_id.empty()) {
            const auto failed =
                ag99::runtime::build_control_playback_finished(
                    turn_id,
                    false,
                    "audio_download_failed");
            websocket_.send_text(failed.dump());
          }
          return;
        }
        const auto deadline = NowSeconds() + playback->duration_seconds;
        while (!closing_.load() && NowSeconds() < deadline) {
          std::this_thread::sleep_for(std::chrono::milliseconds(25));
        }
        if (closing_.load()
            || g_audio_serial.load() != playback->serial
            || turn_id.empty()) {
          return;
        }
        const auto finished =
            ag99::runtime::build_control_playback_finished(turn_id);
        websocket_.send_text(finished.dump());
      });
      return;
    }

    if (!turn_id.empty() && websocket_.connected()) {
      const auto finished =
          ag99::runtime::build_control_playback_finished(turn_id);
      websocket_.send_text(finished.dump());
    }
  }

  ag99::runtime::WinHttpWebSocketClient websocket_;
  MicrophoneCapture microphone_;
  std::function<void(ag99::runtime::ModelSync)> on_model_sync_;
  std::function<void(const ag99::runtime::Json&)> on_motion_intent_;
  ag99::runtime::RuntimeProtocolSession session_;
  std::mutex worker_mutex_;
  std::vector<std::thread> audio_workers_;
  std::atomic<bool> closing_{false};
  std::atomic<std::uint64_t> next_turn_id_{1};
};

csmByte* LoadFile(const std::string path, csmSizeInt* size) {
  if (path.empty() || !size) {
    return nullptr;
  }

  std::filesystem::path resolved_path = path;
  constexpr std::string_view shader_prefix = "FrameworkShaders/";
  if (path.rfind(shader_prefix.data(), 0) == 0 &&
      !g_shader_directory.empty()) {
    resolved_path =
        g_shader_directory / std::filesystem::path(path.substr(shader_prefix.size()));
  }

  FILE* file = nullptr;
  if (fopen_s(&file, resolved_path.string().c_str(), "rb") != 0 || !file) {
    *size = 0;
    return nullptr;
  }

  fseek(file, 0, SEEK_END);
  const long length = ftell(file);
  fseek(file, 0, SEEK_SET);
  if (length <= 0) {
    fclose(file);
    *size = 0;
    return nullptr;
  }

  auto* buffer = static_cast<csmByte*>(std::malloc(static_cast<size_t>(length)));
  if (!buffer || fread(buffer, 1, static_cast<size_t>(length), file) != static_cast<size_t>(length)) {
    std::free(buffer);
    fclose(file);
    *size = 0;
    return nullptr;
  }

  fclose(file);
  *size = static_cast<csmSizeInt>(length);
  return buffer;
}

void ReleaseFile(csmByte* buffer) {
  std::free(buffer);
}

bool ReadFile(const std::filesystem::path& path, std::vector<csmByte>& output) {
  csmSizeInt size = 0;
  csmByte* buffer = LoadFile(path.string(), &size);
  if (!buffer || size <= 0) {
    return false;
  }

  output.assign(buffer, buffer + size);
  ReleaseFile(buffer);
  return true;
}

class NativeModel final {
public:
  ~NativeModel() {
    if (_model) {
      _model->DeleteRenderer();
      delete _model;
      _model = nullptr;
    }
    delete _setting;
    _setting = nullptr;

    for (TextureResource& texture : _textures) {
      if (texture.view) {
        texture.view->Release();
      }
      if (texture.resource) {
        texture.resource->Release();
      }
    }
  }

  bool Load(const std::filesystem::path& model_json, UINT width, UINT height) {
    std::vector<csmByte> setting_bytes;
    if (!ReadFile(model_json, setting_bytes)) {
      std::cerr << "Failed to read model setting: " << model_json.string() << '\n';
      return false;
    }

    _setting = new CubismModelSettingJson(
        setting_bytes.data(), static_cast<csmSizeInt>(setting_bytes.size()));
    const std::filesystem::path model_dir = model_json.parent_path();

    const std::filesystem::path moc_path =
        model_dir / _setting->GetModelFileName();
    std::vector<csmByte> moc_bytes;
    if (!ReadFile(moc_path, moc_bytes)) {
      std::cerr << "Failed to read model moc: " << moc_path.string() << '\n';
      return false;
    }

    _model = new NativeCubismModel();
    _model->LoadModel(
        moc_bytes.data(), static_cast<csmSizeInt>(moc_bytes.size()));
    if (!_model->GetModel()) {
      std::cerr << "Cubism model creation failed\n";
      return false;
    }
    _mouth_parameter_index = _model->GetModel()->GetParameterIndex(
        CubismFramework::GetIdManager()->GetId("ParamMouthOpenY"));

    _model->CreateRenderer(width, height);
    auto* renderer =
        _model->GetRenderer<Rendering::CubismRenderer_D3D11>();
    if (!renderer) {
      std::cerr << "Cubism D3D11 renderer creation failed\n";
      return false;
    }

    csmMap<csmString, csmFloat32> layout;
    _setting->GetLayoutMap(layout);
    _model->GetModelMatrix()->SetupFromLayout(layout);

    for (csmInt32 index = 0; index < _setting->GetTextureCount(); ++index) {
      const char* texture_name = _setting->GetTextureFileName(index);
      if (!texture_name || texture_name[0] == '\0') {
        continue;
      }

      const std::filesystem::path texture_path = model_dir / texture_name;
      TextureResource texture;
      const HRESULT result = DirectX::CreateWICTextureFromFile(
          g_device, g_context, texture_path.wstring().c_str(),
          &texture.resource, &texture.view);
      if (FAILED(result)) {
        std::cerr << "Failed to load texture: " << texture_path.string()
                  << " (0x" << std::hex
                  << static_cast<unsigned long>(result) << std::dec << ")\n";
        return false;
      }

      renderer->BindTexture(
          static_cast<csmUint32>(index), texture.view);
      _textures.push_back(texture);
    }

    if (!_model->LoadDemoMotions(model_dir, _setting)) {
      std::cerr << "[cubism] demo motion groups are unavailable; "
                   "rendering will continue without motion playback\n";
    }

    renderer->IsPremultipliedAlpha(false);
    std::cout << "Loaded Live2D model: " << model_json.string() << '\n';
    return true;
  }

  void UpdateAndDraw() {
    if (!_model || !_model->GetModel()) {
      return;
    }

    CubismModel* cubism_model = _model->GetModel();
    const auto now = NowSeconds();
    const auto delta_seconds = _last_update_seconds > 0.0
        ? static_cast<csmFloat32>(std::clamp(
              now - _last_update_seconds, 0.0, 0.1))
        : 1.0f / 60.0f;
    _last_update_seconds = now;
    if (g_talk_motion_requested.exchange(false)) {
      _model->StartTalkMotion();
    }
    _model->UpdateMotion(delta_seconds);
    ApplyQueuedMotion();
    UpdateAudioLevel();
    if (_mouth_parameter_index >= 0) {
      const float mouth = 0.08f + g_audio_level.load() * 0.92f;
      cubism_model->SetParameterValue(_mouth_parameter_index, mouth);
    }
    cubism_model->Update();

    auto* renderer =
        _model->GetRenderer<Rendering::CubismRenderer_D3D11>();
    renderer->StartFrame(g_context);

    CubismMatrix44 matrix;
    matrix.LoadIdentity();
    matrix.MultiplyByMatrix(_model->GetModelMatrix());
    renderer->SetMvpMatrix(&matrix);
    renderer->DrawModel();
    renderer->EndFrame();
  }

  void SetModelSync(const ag99::runtime::Json& payload) {
    std::scoped_lock lock(_motion_mutex);
    _model_sync_payload = payload;
    std::cerr << "[motion] model sync received\n";
  }

  void QueueMotionIntent(const ag99::runtime::Json& intent) {
    std::scoped_lock lock(_motion_mutex);
    _pending_motion_intent = intent;
    std::cerr << "[motion] intent queued\n";
  }

private:
  struct MotionTrack {
    struct Keyframe {
      int at_ms = 0;
      float target_value = 0.0f;
    };

    csmInt32 parameter_index = -1;
    float neutral_value = 0.0f;
    std::vector<Keyframe> keyframes;
  };

  struct MotionPlan {
    double started_at = 0.0;
    int duration_ms = 900;
    int blend_in_ms = 120;
    int blend_out_ms = 180;
    std::vector<MotionTrack> tracks;
  };

  static double Clamp(double value, double minimum, double maximum) {
    return std::max(minimum, std::min(maximum, value));
  }

  static double ReadNumber(
      const ag99::runtime::Json& object,
      const char* key,
      double fallback) {
    const auto it = object.find(key);
    return it != object.end() && it->is_number()
        ? it->get<double>() : fallback;
  }

  static std::string ReadString(
      const ag99::runtime::Json& object,
      const char* key) {
    const auto it = object.find(key);
    return it != object.end() && it->is_string()
        ? it->get<std::string>() : std::string{};
  }

  const ag99::runtime::Json* SelectedModelProfile() const {
    const auto model_info = _model_sync_payload.find("model_info");
    if (model_info == _model_sync_payload.end()
        || !model_info->is_object()) {
      return nullptr;
    }
    const auto models = model_info->find("models");
    if (models == model_info->end() || !models->is_array()) {
      return nullptr;
    }
    const auto selected = ReadString(*model_info, "selected_model");
    for (const auto& model : *models) {
      if (!model.is_object()) {
        continue;
      }
      if (!selected.empty() && ReadString(model, "name") != selected) {
        continue;
      }
      const auto profile = model.find("semantic_axis_profile");
      if (profile != model.end() && profile->is_object()) {
        return &*profile;
      }
    }
    return nullptr;
  }

  std::optional<MotionPlan> CompileMotionPlan(
      const ag99::runtime::Json& intent) const {
    if (!intent.is_object()
        || ReadString(intent, "schema_version") !=
            std::string(ag99::runtime::kMotionIntentSchema)) {
      std::cerr << "[motion] unsupported motion intent schema\n";
      return std::nullopt;
    }
    const auto profile = SelectedModelProfile();
    if (!profile) {
      std::cerr << "[motion] no semantic axis profile is available\n";
      return std::nullopt;
    }
    const auto profile_id = ReadString(*profile, "profile_id");
    if (!profile_id.empty()
        && ReadString(intent, "profile_id") != profile_id) {
      std::cerr << "[motion] profile id mismatch\n";
      return std::nullopt;
    }

    const auto axes = profile->find("axes");
    if (axes == profile->end() || !axes->is_array()) {
      return std::nullopt;
    }

    struct AxisValue {
      double value = 0.0;
      double neutral = 0.0;
      std::string group;
    };

    using AxisMap = std::unordered_map<std::string, AxisValue>;
    const auto resolve_axis_levels = [&](const ag99::runtime::Json& levels) {
      AxisMap resolved;
      std::unordered_set<std::string> explicit_axes;
      if (!levels.is_object()) {
        return resolved;
      }
      for (const auto& axis : *axes) {
        if (!axis.is_object()) {
          continue;
        }
        const auto id = ReadString(axis, "id");
        const auto level_it = levels.find(id);
        if (id.empty() || level_it == levels.end()
            || !level_it->is_number_integer()) {
          continue;
        }
        const auto role = ReadString(axis, "control_role");
        if (role != "primary" && role != "hint") {
          continue;
        }
        const double neutral = ReadNumber(axis, "neutral", 50.0);
        double value = neutral;
        const auto anchors = axis.find("level_anchors");
        if (anchors != axis.end() && anchors->is_object()) {
          const auto key = std::to_string(level_it->get<int>());
          const auto anchor = anchors->find(key);
          if (anchor != anchors->end() && anchor->is_number()) {
            value = anchor->get<double>();
          }
        }
        const auto range = axis.find("value_range");
        if (range != axis.end() && range->is_array() && range->size() == 2) {
          value = Clamp(
              value, (*range)[0].get<double>(), (*range)[1].get<double>());
        }
        resolved.emplace(
            id, AxisValue{value, neutral, ReadString(axis, "semantic_group")});
        explicit_axes.insert(id);
      }

      const auto relation_graph = profile->find("relation_graph");
      const auto edges = relation_graph != profile->end()
          ? relation_graph->find("edges") : profile->end();
      if (edges != profile->end() && edges->is_array()) {
        for (int pass = 0; pass < 3; ++pass) {
          for (const auto& edge : *edges) {
            if (!edge.is_object()) {
              continue;
            }
            const auto source_id = ReadString(edge, "source_axis_id");
            const auto target_id = ReadString(edge, "target_axis_id");
            const auto source = resolved.find(source_id);
            if (source == resolved.end() || target_id.empty()) {
              continue;
            }
            const auto target_axis = std::ranges::find_if(
                *axes, [&target_id](const auto& axis) {
                  return axis.is_object()
                      && ReadString(axis, "id") == target_id;
                });
            if (target_axis == axes->end()) {
              continue;
            }
            const double target_neutral =
                ReadNumber(*target_axis, "neutral", 50.0);
            const auto target_range = target_axis->find("value_range");
            const double target_min = target_range != target_axis->end()
                && target_range->is_array() && target_range->size() == 2
                ? (*target_range)[0].get<double>() : 0.0;
            const double target_max = target_range != target_axis->end()
                && target_range->is_array() && target_range->size() == 2
                ? (*target_range)[1].get<double>() : 100.0;
            const double source_delta =
                source->second.value - source->second.neutral;
            const double scale = ReadNumber(edge, "scale", 0.0);
            const double direction =
                ReadString(edge, "mode") == "opposite_direction" ? -1.0 : 1.0;
            const double candidate = Clamp(
                target_neutral + source_delta * scale * direction,
                target_min,
                target_max);
            if (explicit_axes.contains(target_id)) {
              continue;
            }
            resolved[target_id] = AxisValue{
                candidate,
                target_neutral,
                ReadString(*target_axis, "semantic_group")};
          }
        }
      }
      return resolved;
    };

    std::vector<std::pair<ag99::runtime::Json, int>> input_steps;
    const auto steps = intent.find("motion_steps");
    if (steps != intent.end()) {
      if (!steps->is_array() || steps->empty()) {
        return std::nullopt;
      }
      for (const auto& step : *steps) {
        if (!step.is_object()) {
          return std::nullopt;
        }
        const auto levels = step.find("axis_levels");
        const auto weight = step.find("duration_weight");
        if (levels == step.end() || !levels->is_object()
            || weight == step.end() || !weight->is_number_integer()) {
          return std::nullopt;
        }
        const int duration_weight = weight->get<int>();
        if (duration_weight < 1 || duration_weight > 3) {
          return std::nullopt;
        }
        input_steps.emplace_back(*levels, duration_weight);
      }
    } else {
      const auto axis_levels = intent.find("axis_levels");
      if (axis_levels == intent.end() || !axis_levels->is_object()) {
        return std::nullopt;
      }
      input_steps.emplace_back(*axis_levels, 1);
    }
    if (input_steps.empty()) {
      return std::nullopt;
    }

    MotionPlan plan;
    plan.duration_ms = static_cast<int>(Clamp(
        ReadNumber(intent, "duration_hint_ms", 900.0), 250.0, 5000.0));
    plan.blend_in_ms = std::min(140, std::max(40, plan.duration_ms / 5));
    plan.blend_out_ms = std::min(220, std::max(80, plan.duration_ms / 5));
    const auto* cubism_model = _model ? _model->GetModel() : nullptr;
    if (!cubism_model) {
      return std::nullopt;
    }
    std::vector<AxisMap> resolved_steps;
    resolved_steps.reserve(input_steps.size());
    int total_weight = 0;
    for (const auto& [levels, weight] : input_steps) {
      resolved_steps.push_back(resolve_axis_levels(levels));
      total_weight += weight;
    }
    if (total_weight <= 0) {
      return std::nullopt;
    }

    std::unordered_set<std::string> used_axis_ids;
    for (const auto& resolved : resolved_steps) {
      for (const auto& [axis_id, _] : resolved) {
        used_axis_ids.insert(axis_id);
      }
    }
    std::unordered_set<csmInt32> bound_parameters;
    for (const auto& axis : *axes) {
      if (!axis.is_object()) {
        continue;
      }
      const auto axis_id = ReadString(axis, "id");
      if (!used_axis_ids.contains(axis_id)) {
        continue;
      }
      const auto bindings = axis.find("parameter_bindings");
      if (bindings == axis.end() || !bindings->is_array()) {
        continue;
      }
      for (const auto& binding : *bindings) {
        if (!binding.is_object()) {
          continue;
        }
        const auto parameter_id = ReadString(binding, "parameter_id");
        const auto parameter = _model->GetModel()->GetParameterIndex(
            CubismFramework::GetIdManager()->GetId(parameter_id.c_str()));
        if (parameter < 0 || bound_parameters.contains(parameter)) {
          continue;
        }
        const auto input_range = binding.find("input_range");
        const auto output_range = binding.find("output_range");
        if (input_range == binding.end() || output_range == binding.end()
            || !input_range->is_array() || !output_range->is_array()
            || input_range->size() != 2 || output_range->size() != 2) {
          continue;
        }
        const double input_min = (*input_range)[0].get<double>();
        const double input_max = (*input_range)[1].get<double>();
        const double output_min = (*output_range)[0].get<double>();
        const double output_max = (*output_range)[1].get<double>();
        if (std::abs(input_max - input_min) < 0.0001) {
          continue;
        }
        const bool invert = binding.value("invert", false);
        const double neutral_ratio = Clamp(
            (ReadNumber(axis, "neutral", 50.0) - input_min)
                / (input_max - input_min),
            0.0, 1.0);
        const double neutral_effective_ratio = invert
            ? 1.0 - neutral_ratio : neutral_ratio;
        const float neutral_target = static_cast<float>(
            output_min + (output_max - output_min) * neutral_effective_ratio);
        std::vector<MotionTrack::Keyframe> keyframes;
        bool axis_started = false;
        AxisValue previous_value{};
        int accumulated_weight = 0;
        for (std::size_t step_index = 0;
             step_index < resolved_steps.size();
             ++step_index) {
          const auto value_it = resolved_steps[step_index].find(axis_id);
          if (value_it != resolved_steps[step_index].end()) {
            previous_value = value_it->second;
            axis_started = true;
          }
          if (!axis_started) {
            accumulated_weight += input_steps[step_index].second;
            continue;
          }
          const double ratio = Clamp(
              (previous_value.value - input_min)
                  / (input_max - input_min),
              0.0,
              1.0);
          const double effective_ratio = invert ? 1.0 - ratio : ratio;
          const float target = static_cast<float>(
              output_min + (output_max - output_min) * effective_ratio);
          const int at_ms = static_cast<int>(std::lround(
              static_cast<double>(plan.duration_ms)
              * static_cast<double>(accumulated_weight)
              / static_cast<double>(total_weight)));
          if (keyframes.empty() || keyframes.back().target_value != target) {
            keyframes.push_back(MotionTrack::Keyframe{at_ms, target});
          }
          accumulated_weight += input_steps[step_index].second;
        }
        if (keyframes.empty()) {
          continue;
        }
        plan.tracks.push_back(MotionTrack{
            parameter,
            neutral_target,
            std::move(keyframes)});
        bound_parameters.insert(parameter);
      }
    }
    if (plan.tracks.empty()) {
      return std::nullopt;
    }
    plan.started_at = NowSeconds();
    return plan;
  }

  void ApplyQueuedMotion() {
    std::scoped_lock lock(_motion_mutex);
    if (!_model || !_model->GetModel()) {
      return;
    }
    if (_pending_motion_intent) {
      const auto plan = CompileMotionPlan(*_pending_motion_intent);
      _pending_motion_intent.reset();
      if (plan) {
        _active_motion = *plan;
        std::cerr << "[motion] compiled " << _active_motion->tracks.size()
                  << " parameter tracks for "
                  << _active_motion->duration_ms << " ms\n";
      }
    }
    if (!_active_motion) {
      return;
    }
    const double elapsed_ms =
        (NowSeconds() - _active_motion->started_at) * 1000.0;
    for (const auto& track : _active_motion->tracks) {
      if (track.keyframes.empty()) {
        continue;
      }
      double value = track.keyframes.back().target_value;
      if (elapsed_ms < _active_motion->blend_in_ms) {
        const double t = Clamp(
            elapsed_ms / std::max(1, _active_motion->blend_in_ms), 0.0, 1.0);
        const double smooth = t * t * (3.0 - 2.0 * t);
        value = track.neutral_value
            + (track.keyframes.front().target_value - track.neutral_value)
                * smooth;
      } else {
        for (std::size_t index = 1; index < track.keyframes.size(); ++index) {
          const auto& previous = track.keyframes[index - 1];
          const auto& next = track.keyframes[index];
          if (elapsed_ms < next.at_ms) {
            const double window = std::max(
                1, next.at_ms - previous.at_ms);
            const double t = Clamp(
                (elapsed_ms - previous.at_ms) / window, 0.0, 1.0);
            const double smooth = t * t * (3.0 - 2.0 * t);
            value = previous.target_value
                + (next.target_value - previous.target_value) * smooth;
            break;
          }
        }
        if (elapsed_ms >= _active_motion->duration_ms
            - _active_motion->blend_out_ms) {
          const double t = Clamp(
              (elapsed_ms - (_active_motion->duration_ms
                  - _active_motion->blend_out_ms))
                  / std::max(1, _active_motion->blend_out_ms),
              0.0, 1.0);
          const double smooth = t * t * (3.0 - 2.0 * t);
          value = track.keyframes.back().target_value
              + (track.neutral_value - track.keyframes.back().target_value)
                  * smooth;
        }
      }
      const double minimum = _model->GetModel()->GetParameterMinimumValue(
          track.parameter_index);
      const double maximum = _model->GetModel()->GetParameterMaximumValue(
          track.parameter_index);
      _model->GetModel()->SetParameterValue(
          track.parameter_index,
          static_cast<csmFloat32>(Clamp(value, minimum, maximum)));
    }
    if (elapsed_ms >= _active_motion->duration_ms) {
      _active_motion.reset();
    }
  }

  NativeCubismModel* _model = nullptr;
  CubismModelSettingJson* _setting = nullptr;
  std::vector<TextureResource> _textures;
  csmInt32 _mouth_parameter_index = -1;
  double _last_update_seconds = 0.0;
  ag99::runtime::Json _model_sync_payload = ag99::runtime::Json::object();
  std::optional<MotionPlan> _active_motion;
  std::optional<ag99::runtime::Json> _pending_motion_intent;
  mutable std::mutex _motion_mutex;
};

void AddTrayIcon(HWND window) {
  g_tray_icon = {};
  g_tray_icon.cbSize = sizeof(g_tray_icon);
  g_tray_icon.hWnd = window;
  g_tray_icon.uID = 1;
  g_tray_icon.uFlags = NIF_ICON | NIF_MESSAGE | NIF_TIP;
  g_tray_icon.uCallbackMessage = kTrayMessage;
  g_tray_icon.hIcon = LoadIconW(nullptr, IDI_APPLICATION);
  wcscpy_s(g_tray_icon.szTip, L"AG99live Native Runtime");
  g_tray_icon_added = Shell_NotifyIconW(NIM_ADD, &g_tray_icon) != FALSE;
}

void RemoveTrayIcon() {
  if (g_tray_icon_added) {
    Shell_NotifyIconW(NIM_DELETE, &g_tray_icon);
    g_tray_icon_added = false;
  }
}

void ShowTrayMenu(HWND window) {
  POINT cursor{};
  GetCursorPos(&cursor);
  HMENU menu = CreatePopupMenu();
  if (!menu) {
    return;
  }
  const bool visible = IsWindowVisible(window) != FALSE;
  AppendMenuW(menu, MF_STRING, kTrayShow, L"显示模型");
  AppendMenuW(menu, MF_STRING, kTrayHide, L"隐藏模型");
  AppendMenuW(menu, MF_STRING, kTrayDemoText, L"发送演示文本");
  AppendMenuW(
      menu,
      MF_STRING,
      kTrayMicToggle,
      g_microphone_running && g_microphone_running()
          ? L"停止麦克风"
          : L"开始麦克风");
  AppendMenuW(menu, MF_SEPARATOR, 0, nullptr);
  AppendMenuW(menu, MF_STRING, kTrayExit, L"退出 AG99live");
  EnableMenuItem(menu, kTrayShow, visible ? MF_GRAYED : MF_ENABLED);
  EnableMenuItem(menu, kTrayHide, visible ? MF_ENABLED : MF_GRAYED);
  SetForegroundWindow(window);
  TrackPopupMenu(
      menu, TPM_RIGHTBUTTON | TPM_BOTTOMALIGN, cursor.x, cursor.y, 0,
      window, nullptr);
  PostMessageW(window, WM_NULL, 0, 0);
  DestroyMenu(menu);
}

LRESULT CALLBACK WindowProc(HWND window, UINT message, WPARAM wparam, LPARAM lparam) {
  switch (message) {
    case WM_ERASEBKGND:
      return 1;
    case WM_LBUTTONDOWN: {
      g_dragging = true;
      g_drag_cursor = {GET_X_LPARAM(lparam), GET_Y_LPARAM(lparam)};
      ClientToScreen(window, &g_drag_cursor);
      RECT rect{};
      GetWindowRect(window, &rect);
      g_drag_origin = {rect.left, rect.top};
      SetCapture(window);
      return 0;
    }
    case WM_MOUSEMOVE:
      if (g_dragging && (wparam & MK_LBUTTON) != 0) {
        POINT cursor{};
        GetCursorPos(&cursor);
        SetWindowPos(
            window, HWND_TOP, g_drag_origin.x + cursor.x - g_drag_cursor.x,
            g_drag_origin.y + cursor.y - g_drag_cursor.y, 0, 0,
            SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER);
      }
      return 0;
    case WM_LBUTTONUP:
      if (g_dragging) {
        g_dragging = false;
        ReleaseCapture();
      }
      return 0;
    case WM_CLOSE:
      ShowWindow(window, SW_HIDE);
      return 0;
    case kTrayMessage:
      if (lparam == WM_RBUTTONUP || lparam == WM_LBUTTONUP ||
          lparam == WM_CONTEXTMENU) {
        ShowTrayMenu(window);
      }
      return 0;
    case WM_COMMAND:
      switch (LOWORD(wparam)) {
        case kTrayShow:
          ShowWindow(window, SW_SHOWNOACTIVATE);
          return 0;
        case kTrayHide:
          ShowWindow(window, SW_HIDE);
          return 0;
        case kTrayDemoText:
          if (g_send_text) {
            g_send_text("你好，这是原生 Live2D 核心演示。");
          }
          return 0;
        case kTrayMicToggle:
          if (g_toggle_microphone) {
            g_toggle_microphone();
          }
          return 0;
        case kTrayExit:
          RemoveTrayIcon();
          DestroyWindow(window);
          return 0;
        default:
          break;
      }
      break;
    case WM_DESTROY:
      RemoveTrayIcon();
      PostQuitMessage(0);
      return 0;
    default:
      return DefWindowProcW(window, message, wparam, lparam);
  }
  return DefWindowProcW(window, message, wparam, lparam);
}

bool CreateRenderTarget() {
  ID3D11Texture2D* back_buffer = nullptr;
  if (FAILED(g_swap_chain->GetBuffer(0, IID_PPV_ARGS(&back_buffer)))) {
    return false;
  }

  const HRESULT result = g_device->CreateRenderTargetView(
      back_buffer, nullptr, &g_render_target);
  back_buffer->Release();
  return SUCCEEDED(result);
}

bool CreateDevice(HWND window, UINT width, UINT height) {
  DXGI_SWAP_CHAIN_DESC description{};
  description.BufferCount = 2;
  description.BufferDesc.Width = width;
  description.BufferDesc.Height = height;
  description.BufferDesc.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
  description.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
  description.OutputWindow = window;
  description.SampleDesc.Count = 1;
  description.SwapEffect = DXGI_SWAP_EFFECT_FLIP_SEQUENTIAL;
  description.Windowed = TRUE;

  D3D_FEATURE_LEVEL feature_level{};
  const HRESULT result = D3D11CreateDeviceAndSwapChain(
      nullptr,
      D3D_DRIVER_TYPE_HARDWARE,
      nullptr,
      D3D11_CREATE_DEVICE_SINGLETHREADED,
      nullptr,
      0,
      D3D11_SDK_VERSION,
      &description,
      &g_swap_chain,
      &g_device,
      &feature_level,
      &g_context);
  if (FAILED(result)) {
    std::cerr << "D3D11CreateDeviceAndSwapChain failed: 0x"
              << std::hex << static_cast<unsigned long>(result) << '\n';
    return false;
  }

  return CreateRenderTarget();
}

void ReleaseGraphics() {
  if (g_render_target) {
    g_render_target->Release();
    g_render_target = nullptr;
  }
  if (g_swap_chain) {
    g_swap_chain->Release();
    g_swap_chain = nullptr;
  }
  if (g_context) {
    g_context->Release();
    g_context = nullptr;
  }
  if (g_device) {
    g_device->Release();
    g_device = nullptr;
  }
}

HWND CreateWindowHandle(HINSTANCE instance, UINT width, UINT height) {
  WNDCLASSEXW window_class{
      sizeof(WNDCLASSEXW),
      CS_HREDRAW | CS_VREDRAW,
      WindowProc,
      0,
      0,
      instance,
      nullptr,
      LoadCursorW(nullptr, IDC_ARROW),
      nullptr,
      nullptr,
      kWindowClassName,
      nullptr};

  if (!RegisterClassExW(&window_class)) {
    return nullptr;
  }

  HWND window = CreateWindowExW(
      WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
      kWindowClassName,
      kWindowTitle,
      WS_POPUP,
      CW_USEDEFAULT,
      CW_USEDEFAULT,
      static_cast<int>(width),
      static_cast<int>(height),
      nullptr,
      nullptr,
      instance,
      nullptr);
  if (!window) {
    return nullptr;
  }

  const int x = (GetSystemMetrics(SM_CXSCREEN) - static_cast<int>(width)) / 2;
  const int y = (GetSystemMetrics(SM_CYSCREEN) - static_cast<int>(height)) / 2;
  SetWindowPos(window, HWND_TOP, x, y, static_cast<int>(width),
               static_cast<int>(height), SWP_NOACTIVATE | SWP_SHOWWINDOW);

  MARGINS margins{-1, -1, -1, -1};
  DwmExtendFrameIntoClientArea(window, &margins);
  return window;
}

bool StartCubism() {
  CubismFramework::Option option{};
  option.LogFunction = LogMessage;
  option.LoadFileFunction = LoadFile;
  option.ReleaseBytesFunction = ReleaseFile;
  option.LoggingLevel = CubismFramework::Option::LogLevel_Info;
  if (!CubismFramework::StartUp(&g_allocator, &option)) {
    return false;
  }

  CubismFramework::Initialize();
  Rendering::CubismRenderer_D3D11::SetConstantSettings(2, g_device);
  return true;
}

void StopCubism() {
  // The D3D11 device-info map owns resources through Cubism's allocator.
  // Release it before Dispose/CleanUp clears that allocator.
  Rendering::CubismDeviceInfo_D3D11::ReleaseAllDeviceInfo();
  if (CubismFramework::IsInitialized()) {
    CubismFramework::Dispose();
  }
  CubismFramework::CleanUp();
}

int Run(
    HINSTANCE instance,
    const std::filesystem::path& model_json,
    const std::string& startup_text) {
  constexpr UINT width = 640;
  constexpr UINT height = 820;
  HWND window = CreateWindowHandle(instance, width, height);
  if (!window || !CreateDevice(window, width, height)) {
    RemoveTrayIcon();
    ReleaseGraphics();
    return 1;
  }
  g_window = window;
  AddTrayIcon(window);

  if (!StartCubism()) {
    RemoveTrayIcon();
    DestroyWindow(window);
    ReleaseGraphics();
    return 1;
  }

  int result_code = 0;
  {
    NativeModel model;
    RuntimeBridge runtime(
        [&model](ag99::runtime::ModelSync sync) {
          model.SetModelSync(sync.payload);
        },
        [&model](const ag99::runtime::Json& motion_intent) {
          model.QueueMotionIntent(motion_intent);
        });
    g_send_text = [&runtime](std::string text) {
      if (!runtime.SendText(text)) {
        std::cerr << "[runtime] failed to send demo text\n";
      }
    };
    g_toggle_microphone = [&runtime] {
      runtime.ToggleMicrophone();
    };
    g_microphone_running = [&runtime] {
      return runtime.MicrophoneRunning();
    };
    if (!model_json.empty() && !model.Load(model_json, width, height)) {
      result_code = 1;
    } else {
      if (!runtime.Connect("ws://127.0.0.1:12396")) {
        std::cerr << "[runtime] adapter connection unavailable; tray/render demo continues\n";
      } else if (!startup_text.empty()) {
        g_send_text(startup_text);
      }
      ShowWindow(window, SW_SHOWNOACTIVATE);
      UpdateWindow(window);

      MSG message{};
      bool running = true;
      while (running) {
        while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) {
          if (message.message == WM_QUIT) {
            running = false;
          }
          TranslateMessage(&message);
          DispatchMessageW(&message);
        }

        constexpr float clear_color[4] = {0.0f, 0.0f, 0.0f, 0.0f};
        g_context->OMSetRenderTargets(1, &g_render_target, nullptr);
        g_context->ClearRenderTargetView(g_render_target, clear_color);
        model.UpdateAndDraw();
        g_swap_chain->Present(1, 0);
        Sleep(1);
      }
    }
    runtime.Close();
    g_send_text = {};
    g_toggle_microphone = {};
    g_microphone_running = {};
  }

  StopCurrentAudio();
  DestroyWindow(window);
  UnregisterClassW(kWindowClassName, instance);
  StopCubism();
  ReleaseGraphics();
  return result_code;
}

}  // namespace

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE, PWSTR, int) {
  const HRESULT com_result = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  if (FAILED(com_result) && com_result != RPC_E_CHANGED_MODE) {
    return 1;
  }

  int argument_count = 0;
  LPWSTR* arguments =
      CommandLineToArgvW(GetCommandLineW(), &argument_count);
  std::filesystem::path model_json;
  std::string startup_text;
  if (arguments && argument_count > 1) {
    model_json = arguments[1];
  }
  for (int index = 2; index < argument_count; ++index) {
    const std::wstring argument = arguments[index];
    constexpr std::wstring_view prefix = L"--text=";
    if (argument.starts_with(prefix)) {
      const auto value = argument.substr(prefix.size());
      const int length = WideCharToMultiByte(
          CP_UTF8,
          0,
          value.data(),
          static_cast<int>(value.size()),
          nullptr,
          0,
          nullptr,
          nullptr);
      if (length > 0) {
        startup_text.resize(static_cast<std::size_t>(length));
        WideCharToMultiByte(
            CP_UTF8,
            0,
            value.data(),
            static_cast<int>(value.size()),
            startup_text.data(),
            length,
            nullptr,
            nullptr);
      }
    }
  }
  if (arguments) {
    LocalFree(arguments);
  }
  const int result = Run(instance, model_json, startup_text);
  if (SUCCEEDED(com_result)) {
    CoUninitialize();
  }
  return result;
}
