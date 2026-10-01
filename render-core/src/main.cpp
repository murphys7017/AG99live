#include <windows.h>
#include <mmsystem.h>
#include <shellapi.h>
#include <winhttp.h>
#include <windowsx.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <cctype>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <condition_variable>
#include <deque>
#include <filesystem>
#include <functional>
#include <iostream>
#include <malloc.h>
#include <mutex>
#include <optional>
#include <random>
#include <string>
#include <string_view>
#include <thread>
#include <typeinfo>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

#include "ag99/runtime/protocol.hpp"
#include "ag99/runtime/runtime_session.hpp"
#include "ag99/runtime/winhttp_websocket.hpp"
#include "ag99/live2d/d3d11_composition_surface.hpp"
#include "ag99/live2d/d3d11_renderer.hpp"
#include <CubismFramework.hpp>
#include <CubismModelSettingJson.hpp>
#include <Effect/CubismBreath.hpp>
#include <Effect/CubismEyeBlink.hpp>
#include <Id/CubismIdManager.hpp>
#include <Model/CubismUserModel.hpp>
#include <Motion/ACubismMotion.hpp>
#include <Motion/CubismMotion.hpp>
#include <Motion/CubismExpressionMotionManager.hpp>
#include <Physics/CubismPhysicsJson.hpp>

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

NOTIFYICONDATAW g_tray_icon{};
bool g_tray_icon_added = false;
bool g_dragging = false;
POINT g_drag_cursor{};
POINT g_drag_origin{};
std::atomic<double> g_audio_end_seconds{0.0};
std::atomic<double> g_audio_start_seconds{0.0};
std::atomic<float> g_audio_level{0.0f};
std::atomic<float> g_lip_sync_intensity{0.0f};
std::atomic<float> g_speech_energy_input{0.0f};
std::atomic<float> g_speech_head_envelope{0.0f};
std::atomic<float> g_speech_body_envelope{0.0f};
std::atomic<float> g_speech_emphasis_envelope{0.0f};
std::atomic<bool> g_speech_voiced{false};
std::atomic<float> g_drag_x{0.0f};
std::atomic<float> g_drag_y{0.0f};
std::atomic<std::uint64_t> g_audio_serial{0};
std::mutex g_audio_file_mutex;
std::mutex g_audio_signal_mutex;
std::wstring g_audio_file;
std::vector<float> g_audio_rms;
std::function<void(std::string)> g_send_text;
std::function<void()> g_toggle_microphone;
std::function<bool()> g_microphone_running;

constexpr float kSpeechHeadAttack = 10.0f;
constexpr float kSpeechHeadRelease = 3.4f;
constexpr float kSpeechBodyAttack = 5.5f;
constexpr float kSpeechBodyRelease = 2.4f;
constexpr float kSpeechHeadActivityFloor = 0.42f;
constexpr float kSpeechHeadGainSpan = 1.32f;
constexpr float kSpeechHeadGainMax = 1.68f;
constexpr float kSpeechPitchGainMax = 1.25f;
constexpr float kSpeechBodyActivityFloor = 0.34f;
constexpr float kSpeechBodyGainSpan = 1.0f;
constexpr float kSpeechBodyGainMax = 1.18f;
constexpr float kSpeechVoicedEnter = 0.028f;
constexpr float kSpeechVoicedExit = 0.012f;
constexpr float kSpeechEmphasisRiseThreshold = 1.5f;
constexpr float kSpeechEmphasisRiseGain = 0.09f;
constexpr float kSpeechEmphasisAttack = 18.0f;
constexpr float kSpeechEmphasisRelease = 7.0f;
constexpr float kSpeechEmphasisMax = 0.42f;

float AdvanceSpeechEnvelope(
    float current,
    float target,
    float delta_seconds,
    float attack_per_second,
    float release_per_second) {
  const auto rate = target > current ? attack_per_second : release_per_second;
  const auto blend = 1.0f - std::exp(
      -std::max(0.0f, delta_seconds) * rate);
  return current + (target - current) * blend;
}

double NowSeconds() {
  return std::chrono::duration<double>(
      std::chrono::steady_clock::now().time_since_epoch()).count();
}

void UpdateAudioLevel(float delta_seconds) {
  const double now = NowSeconds();
  const double remaining = g_audio_end_seconds.load() - now;
  if (remaining <= 0.0) {
    g_audio_level.store(0.0f);
    g_lip_sync_intensity.store(0.0f);
    g_speech_energy_input.store(0.0f);
  } else {
    const double elapsed = std::max(0.0, now - g_audio_start_seconds.load());
    float level = 0.0f;
    {
      std::scoped_lock lock(g_audio_signal_mutex);
      const auto index = static_cast<std::size_t>(elapsed * 50.0);
      if (index < g_audio_rms.size()) {
        level = std::max(0.0f, g_audio_rms[index]);
      }
    }
    g_audio_level.store(level);
    g_lip_sync_intensity.store(std::clamp((level - 0.012f) * 30.0f, 0.0f, 1.0f));
    g_speech_energy_input.store(std::clamp((level - 0.008f) * 5.5f, 0.0f, 1.0f));
  }
  const float speech_energy = g_speech_energy_input.load();
  const bool was_voiced = g_speech_voiced.load();
  const bool voiced = speech_energy >= (was_voiced
      ? kSpeechVoicedExit : kSpeechVoicedEnter);
  g_speech_voiced.store(voiced);
  const float target_energy = voiced ? speech_energy : 0.0f;
  const float previous_head = g_speech_head_envelope.load();
  const float head = AdvanceSpeechEnvelope(
      previous_head,
      target_energy,
      delta_seconds,
      kSpeechHeadAttack,
      kSpeechHeadRelease);
  const float body = AdvanceSpeechEnvelope(
      g_speech_body_envelope.load(),
      target_energy,
      delta_seconds,
      kSpeechBodyAttack,
      kSpeechBodyRelease);
  const float positive_rise = delta_seconds > 0.0f
      ? std::max(0.0f, head - previous_head) / delta_seconds
      : 0.0f;
  const float emphasis_target = voiced
      ? std::clamp(
          (positive_rise - kSpeechEmphasisRiseThreshold)
              * kSpeechEmphasisRiseGain,
          0.0f,
          kSpeechEmphasisMax)
      : 0.0f;
  const float emphasis = AdvanceSpeechEnvelope(
      g_speech_emphasis_envelope.load(),
      emphasis_target,
      delta_seconds,
      kSpeechEmphasisAttack,
      kSpeechEmphasisRelease);
  g_speech_head_envelope.store(head < 0.001f ? 0.0f : head);
  g_speech_body_envelope.store(body < 0.001f ? 0.0f : body);
  g_speech_emphasis_envelope.store(emphasis < 0.001f ? 0.0f : emphasis);
}

float GetSpeechAudioGain(std::string_view axis_id) {
  const auto channel_name = axis_id.starts_with("voice_following.")
      ? axis_id.substr(std::string_view("voice_following.").size())
      : axis_id;
  const auto separator = channel_name.find('|');
  const auto channel = channel_name.substr(0, separator);
  const bool body = channel.starts_with("body_");
  const auto voiced = g_speech_voiced.load();
  const auto activity_floor = voiced
      ? (body ? kSpeechBodyActivityFloor : kSpeechHeadActivityFloor)
      : 0.0f;
  const auto raw_gain = body
      ? std::min(
          kSpeechBodyGainMax,
          activity_floor
              + g_speech_body_envelope.load() * kSpeechBodyGainSpan
              + g_speech_emphasis_envelope.load() * 0.24f)
      : std::min(
          kSpeechHeadGainMax,
          activity_floor
              + g_speech_head_envelope.load() * kSpeechHeadGainSpan
              + g_speech_emphasis_envelope.load() * 0.38f);
  return channel.find("pitch") != std::string_view::npos
      ? std::min(kSpeechPitchGainMax, raw_gain)
      : raw_gain;
}

void ResetSpeechSignal() {
  g_speech_head_envelope.store(0.0f);
  g_speech_body_envelope.store(0.0f);
  g_speech_emphasis_envelope.store(0.0f);
  g_speech_voiced.store(false);
  g_lip_sync_intensity.store(0.0f);
  g_speech_energy_input.store(0.0f);
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
  ResetSpeechSignal();
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

#ifndef AG99_CUBISM_SHADER_DIR
#define AG99_CUBISM_SHADER_DIR ""
#endif

const std::filesystem::path g_shader_directory = AG99_CUBISM_SHADER_DIR;

void LogMessage(const csmChar* message) {
  if (message) {
    std::cerr << "[cubism] " << message << '\n';
  }
}

bool ReadFile(const std::filesystem::path& path, std::vector<csmByte>& output);

class NativeCubismModel final : public CubismUserModel {
public:
  ~NativeCubismModel() override {
    if (_eye_blink) {
      CubismEyeBlink::Delete(_eye_blink);
    }
    if (_breath) {
      CubismBreath::Delete(_breath);
    }
    for (auto& [group, motions] : _motion_groups) {
      for (auto* motion : motions) {
        ACubismMotion::Delete(motion);
      }
    }
    for (auto* expression : _expressions) {
      ACubismMotion::Delete(expression);
    }
  }

  bool LoadConfiguredEffects(
      const std::filesystem::path& model_directory,
      CubismModelSettingJson* setting) {
    if (!setting) {
      return false;
    }

    bool loaded_any = false;
    const auto load_effect = [&](const char* file_name,
                                 const char* label,
                                 const auto& loader) {
      if (!file_name || file_name[0] == '\0') {
        return false;
      }
      std::vector<csmByte> bytes;
      const auto path = model_directory / file_name;
      if (!ReadFile(path, bytes)) {
        std::cerr << "[cubism] failed to read " << label
                  << ": " << path.string() << '\n';
        return false;
      }
      loader(bytes);
      return true;
    };

    loaded_any = load_effect(
        setting->GetPhysicsFileName(),
        "physics",
        [this](const std::vector<csmByte>& bytes) {
          LoadPhysics(
              bytes.data(), static_cast<csmSizeInt>(bytes.size()));
          ConfigurePhysicsResponse(bytes);
        }) || loaded_any;
    loaded_any = load_effect(
        setting->GetPoseFileName(),
        "pose",
        [this](const std::vector<csmByte>& bytes) {
          LoadPose(
              bytes.data(), static_cast<csmSizeInt>(bytes.size()));
        }) || loaded_any;

    for (csmInt32 index = 0;
         index < setting->GetExpressionCount();
         ++index) {
      const char* name = setting->GetExpressionName(index);
      const char* file_name = setting->GetExpressionFileName(index);
      if (!name || !file_name || file_name[0] == '\0') {
        continue;
      }
      std::vector<csmByte> bytes;
      const auto path = model_directory / file_name;
      if (!ReadFile(path, bytes)) {
        std::cerr << "[cubism] failed to read expression "
                  << name << ": " << path.string() << '\n';
        continue;
      }
      if (auto* expression = LoadExpression(
              bytes.data(), static_cast<csmSizeInt>(bytes.size()), name)) {
        _expression_names.emplace_back(name);
        _expression_by_name.emplace(name, expression);
        _expressions.push_back(expression);
        loaded_any = true;
      }
    }
    return loaded_any;
  }

  bool StartExpressionById(const std::string& expression_id) {
    if (!_expressionManager || expression_id.empty()) {
      return false;
    }
    const auto it = _expression_by_name.find(expression_id);
    if (it == _expression_by_name.end() || !it->second) {
      return false;
    }
    return _expressionManager->StartMotion(it->second, false)
        != InvalidMotionQueueEntryHandleValue;
  }

  void ConfigurePhysicsResponse(const std::vector<csmByte>& bytes) {
    if (bytes.empty() || !_model) {
      return;
    }
    CubismPhysicsJson physics_json(
        bytes.data(), static_cast<csmSizeInt>(bytes.size()));
    _physics_input_parameter_ids.clear();
    _physics_output_parameter_ids.clear();
    for (csmInt32 setting_index = 0;
         setting_index < physics_json.GetSubRigCount();
         ++setting_index) {
      for (csmInt32 input_index = 0;
           input_index < physics_json.GetInputCount(setting_index);
           ++input_index) {
        const auto id = physics_json.GetInputSourceId(
            setting_index, input_index);
        if (id) {
          _physics_input_parameter_ids.insert(id->GetString().GetRawString());
        }
      }
      for (csmInt32 output_index = 0;
           output_index < physics_json.GetOutputCount(setting_index);
           ++output_index) {
        const auto id = physics_json.GetOutputsDestinationId(
            setting_index, output_index);
        if (id) {
          _physics_output_parameter_ids.insert(id->GetString().GetRawString());
        }
      }
    }
    RefreshPhysicsResponseParameterIndices();
  }

  void SetPhysicsResponseProtectedParameterIds(
      const std::unordered_set<std::string>& parameter_ids) {
    _physics_response_protected_parameter_ids = parameter_ids;
    RefreshPhysicsResponseParameterIndices();
  }

  void SetPhysicsResponseScale(float scale) {
    if (std::isfinite(scale) && scale > 0.0f) {
      _physics_response_scale = scale;
    }
  }

  bool LoadDemoMotions(
      const std::filesystem::path& model_directory,
      CubismModelSettingJson* setting) {
    if (!setting) {
      return false;
    }
    _eye_blink = CubismEyeBlink::Create(setting);
    _breath = CubismBreath::Create();
    if (_breath) {
      csmVector<CubismBreath::BreathParameterData> breath_parameters;
      auto* ids = CubismFramework::GetIdManager();
      if (ids) {
        breath_parameters.PushBack(CubismBreath::BreathParameterData(
            ids->GetId("ParamAngleX"), 0.0f, 15.0f, 6.5345f, 0.5f));
        breath_parameters.PushBack(CubismBreath::BreathParameterData(
            ids->GetId("ParamAngleY"), 0.0f, 8.0f, 3.5345f, 0.5f));
        breath_parameters.PushBack(CubismBreath::BreathParameterData(
            ids->GetId("ParamAngleZ"), 0.0f, 10.0f, 5.5345f, 0.5f));
        breath_parameters.PushBack(CubismBreath::BreathParameterData(
            ids->GetId("ParamBodyAngleX"), 0.0f, 4.0f, 15.5345f, 0.5f));
        breath_parameters.PushBack(CubismBreath::BreathParameterData(
            ids->GetId("ParamBreath"), 0.5f, 0.5f, 3.2345f, 1.0f));
      }
      _breath->SetParameters(breath_parameters);
    }
    csmVector<CubismIdHandle> eye_blink_ids;
    for (csmInt32 index = 0;
         index < setting->GetEyeBlinkParameterCount();
         ++index) {
      eye_blink_ids.PushBack(setting->GetEyeBlinkParameterId(index));
    }
    csmVector<CubismIdHandle> lip_sync_ids;
    for (csmInt32 index = 0;
         index < setting->GetLipSyncParameterCount();
         ++index) {
      lip_sync_ids.PushBack(setting->GetLipSyncParameterId(index));
    }
    _lip_sync_parameter_indices.clear();
    for (csmInt32 index = 0; index < lip_sync_ids.GetSize(); ++index) {
      const auto parameter_index = _model->GetParameterIndex(lip_sync_ids.At(index));
      if (parameter_index >= 0) {
        _lip_sync_parameter_indices.push_back(parameter_index);
      }
    }
    for (csmInt32 group_index = 0;
         group_index < setting->GetMotionGroupCount();
         ++group_index) {
      const char* group = setting->GetMotionGroupName(group_index);
      if (!group) {
        continue;
      }
      auto& motions = _motion_groups[group];
      for (csmInt32 index = 0;
           index < setting->GetMotionCount(group);
           ++index) {
        if (auto* motion = LoadDemoMotion(
                model_directory, setting, group, index, group)) {
          static_cast<CubismMotion*>(motion)->SetEffectIds(
              eye_blink_ids, lip_sync_ids);
          motions.push_back(motion);
        }
      }
    }
    if (_motion_groups["Idle"].empty()) {
      std::cerr << "[cubism] no Idle group motions were available\n";
    }
    return !_motion_groups["Idle"].empty();
  }

  const std::vector<csmInt32>& LipSyncParameterIndices() const noexcept {
    return _lip_sync_parameter_indices;
  }

  void ApplyDrag(float drag_x, float drag_y) {
    AddNormalizedParameterValue("ParamAngleX", drag_x);
    AddNormalizedParameterValue("ParamAngleY", drag_y);
    AddNormalizedParameterValue("ParamAngleZ", drag_x * drag_y * -1.0f);
    AddNormalizedParameterValue("ParamBodyAngleX", drag_x);
    AddNormalizedParameterValue("ParamEyeBallX", drag_x);
    AddNormalizedParameterValue("ParamEyeBallY", drag_y);
  }

  void UpdateMotion(csmFloat32 delta_seconds) {
    if (!_motionManager || !_model) {
      return;
    }

    _model->LoadParameters();
    bool motion_updated = false;
    if (_motionManager->IsFinished()) {
      const auto idle = _motion_groups.find("Idle");
      if (idle != _motion_groups.end() && !idle->second.empty()) {
        std::uniform_int_distribution<std::size_t> choose_idle(
            0, idle->second.size() - 1);
        _motionManager->StartMotionPriority(
            idle->second[choose_idle(_motion_random)], false, 1);
      }
    } else {
      motion_updated = _motionManager->UpdateMotion(_model, delta_seconds);
    }
    _model->SaveParameters();
    if (_eye_blink && !motion_updated) {
      _eye_blink->UpdateParameters(_model, delta_seconds);
    }
    if (_expressionManager) {
      _expressionManager->UpdateMotion(_model, delta_seconds);
    }
    if (_breath) {
      _breath->UpdateParameters(_model, delta_seconds);
    }
  }

  void UpdatePhysicsAndPose(csmFloat32 delta_seconds) {
    if (!_model) {
      return;
    }
    if (_physics) {
      const bool scale_response = CapturePhysicsResponseBaseline();
      _physics->Evaluate(_model, delta_seconds);
      if (scale_response) {
        ApplyPhysicsResponseScale();
      }
    }
    if (_pose) {
      _pose->UpdateParameters(_model, delta_seconds);
    }
  }

private:
  void RefreshPhysicsResponseParameterIndices() {
    _physics_response_parameter_indices.clear();
    _physics_response_baseline_values.clear();
    if (!_model) {
      return;
    }
    for (const auto& parameter_id : _physics_output_parameter_ids) {
      if (_physics_input_parameter_ids.contains(parameter_id)
          || _physics_response_protected_parameter_ids.contains(parameter_id)) {
        continue;
      }
      const auto parameter_index = _model->GetParameterIndex(
          CubismFramework::GetIdManager()->GetId(parameter_id.c_str()));
      if (parameter_index >= 0) {
        _physics_response_parameter_indices.push_back(parameter_index);
        _physics_response_baseline_values.push_back(0.0f);
      }
    }
  }

  bool CapturePhysicsResponseBaseline() {
    if (_physics_response_scale == 1.0f
        || _physics_response_parameter_indices.empty()) {
      return false;
    }
    for (std::size_t index = 0;
         index < _physics_response_parameter_indices.size();
         ++index) {
      _physics_response_baseline_values[index] =
          _model->GetParameterValue(_physics_response_parameter_indices[index]);
    }
    return true;
  }

  void ApplyPhysicsResponseScale() {
    for (std::size_t index = 0;
         index < _physics_response_parameter_indices.size();
         ++index) {
      const auto parameter_index = _physics_response_parameter_indices[index];
      const auto before = _physics_response_baseline_values[index];
      const auto after = _model->GetParameterValue(parameter_index);
      const auto minimum = _model->GetParameterMinimumValue(parameter_index);
      const auto maximum = _model->GetParameterMaximumValue(parameter_index);
      _model->SetParameterValue(
          parameter_index,
          std::clamp(
              before + (after - before) * _physics_response_scale,
              minimum,
              maximum));
    }
  }

  void AddNormalizedParameterValue(
      const char* parameter_id,
      float normalized_value) {
    if (!_model || !parameter_id || !std::isfinite(normalized_value)) {
      return;
    }
    const auto parameter_index = _model->GetParameterIndex(
        CubismFramework::GetIdManager()->GetId(parameter_id));
    if (parameter_index < 0) {
      return;
    }
    const auto clamped = std::clamp(normalized_value, -1.0f, 1.0f);
    const auto minimum = _model->GetParameterMinimumValue(parameter_index);
    const auto default_value = _model->GetParameterDefaultValue(parameter_index);
    const auto maximum = _model->GetParameterMaximumValue(parameter_index);
    const auto delta = clamped >= 0.0f
        ? (maximum - default_value) * clamped
        : (default_value - minimum) * clamped;
    _model->SetParameterValue(parameter_index, default_value + delta);
  }

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

  std::unordered_map<std::string, std::vector<ACubismMotion*>> _motion_groups;
  std::mt19937 _motion_random{std::random_device{}()};
  std::vector<ACubismMotion*> _expressions;
  std::vector<std::string> _expression_names;
  std::unordered_map<std::string, ACubismMotion*> _expression_by_name;
  std::vector<csmInt32> _lip_sync_parameter_indices;
  std::unordered_set<std::string> _physics_input_parameter_ids;
  std::unordered_set<std::string> _physics_output_parameter_ids;
  std::unordered_set<std::string> _physics_response_protected_parameter_ids;
  std::vector<csmInt32> _physics_response_parameter_indices;
  std::vector<csmFloat32> _physics_response_baseline_values;
  csmFloat32 _physics_response_scale = 1.0f;
  CubismEyeBlink* _eye_blink = nullptr;
  CubismBreath* _breath = nullptr;
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
    const auto open_result = waveInOpen(
        &device,
        WAVE_MAPPER,
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
  void Stop(std::string_view reason) {
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
    std::uint64_t dropped = 0;
    bool was_running = running_stream_active_;
    {
      std::scoped_lock queue_lock(queue_mutex_);
      if (was_running) {
        stream_id = stream_id_;
        last_sequence = sequence_ == 0
            ? std::nullopt
            : std::optional<std::uint64_t>{sequence_ - 1};
      }
      running_stream_active_ = false;
      dropped = dropped_frames_;
      dropped_frames_ = 0;
      stream_id_.clear();
      turn_id_.clear();
      sequence_ = 0;
      pending_frames_.clear();
    }
    if (dropped > 0) {
      std::cerr << "[microphone] dropped " << dropped
                << " captured bytes while sending\n";
    }
    if (stream_id.empty() || !websocket_.connected()) {
      return;
    }
    const auto end_message = ag99::runtime::build_input_audio_stream_end(
        stream_id,
        reason,
        false,
        last_sequence,
        "manual");
    websocket_.send_text(end_message.dump());
  }

  bool running() const noexcept {
    return running_.load();
  }

private:
  static constexpr std::size_t kBufferCount = 4;
  static constexpr std::size_t kBufferBytes = 3200;
  // Capture runs at 16 kHz mono, so 100 ms of audio; anything queued beyond
  // this was already dropped by the driver before we could send it.
  static constexpr std::size_t kMaxQueuedFrames = 16;

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

  // Driver callback: copy, re-arm, return. No allocation-heavy work, no
  // network I/O, and never a device teardown from this thread.
  void OnBuffer(WAVEHDR* header) {
    if (!running_.load() || !header || header->dwBytesRecorded == 0) {
      return;
    }
    {
      std::scoped_lock lock(queue_mutex_);
      if (pending_frames_.size() >= kMaxQueuedFrames) {
        dropped_frames_ += header->dwBytesRecorded;
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

  void AudioSenderLoop() {
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
        CloseDevice();
        return;
      }
    }
  }

  // Must run off the driver callback. stop_mutex_ serialises callers and is
  // recursive because Stop() calls into this.
  void CloseDevice() {
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

  std::string StreamId() const {
    std::scoped_lock lock(queue_mutex_);
    return stream_id_;
  }

  std::string TurnId() const {
    std::scoped_lock lock(queue_mutex_);
    return turn_id_;
  }

  ag99::runtime::WinHttpWebSocketClient& websocket_;
  std::atomic<HWAVEIN> device_{nullptr};
  std::array<std::vector<std::uint8_t>, kBufferCount> buffers_{};
  std::array<WAVEHDR, kBufferCount> headers_{};
  std::array<bool, kBufferCount> prepared_{};
  std::atomic<bool> running_{false};
  // Guards the capture queue and the stream identity fields. Never held
  // across a waveIn or websocket call.
  mutable std::mutex queue_mutex_;
  std::condition_variable queue_condition_;
  std::deque<std::vector<std::uint8_t>> pending_frames_;
  std::uint64_t dropped_frames_ = 0;
  // True between a successful stream start and its matching end, so Stop
  // still emits input.audio_stream_end after the sender already cleared
  // running_.
  bool running_stream_active_ = false;
  std::string stream_id_;
  std::string turn_id_;
  std::uint64_t sequence_ = 0;
  std::atomic<std::uint64_t> next_stream_serial_{1};
  // Serialises Stop against CloseDevice, including the Stop -> CloseDevice
  // re-entry, so the waveIn teardown runs exactly once.
  std::recursive_mutex stop_mutex_;
  std::mutex join_mutex_;
  std::thread audio_worker_;
};

class RuntimeBridge final {
public:
  RuntimeBridge(
      std::function<void(ag99::runtime::ModelSync)> on_model_sync,
      std::function<void(const ag99::runtime::Json&, const std::string&)> on_motion_intent,
      std::function<void(const std::string&)> on_turn_started,
      std::function<void(const std::string&)> on_turn_finished)
      : microphone_(websocket_),
        on_model_sync_(std::move(on_model_sync)),
        on_motion_intent_(std::move(on_motion_intent)),
        on_turn_started_(std::move(on_turn_started)),
        on_turn_finished_(std::move(on_turn_finished)),
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
              if (on_turn_started_) {
                on_turn_started_(turn_id);
              }
            },
            [this](std::string turn_id) {
              if (on_turn_finished_) {
                on_turn_finished_(turn_id);
              }
            },
        }) {
    audio_worker_ = std::thread([this] {
      AudioWorkerLoop();
    });
  }

  ~RuntimeBridge() {
    Close();
  }

  bool Connect(const std::string& url) {
    if (closing_.load()) {
      return false;
    }
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
    const bool was_closing = closing_.exchange(true);
    if (!was_closing) {
      microphone_.Stop("runtime_shutdown");
      websocket_.close();
    }
    audio_queue_condition_.notify_all();
    if (audio_worker_.joinable()) {
      audio_worker_.join();
    }
    if (!was_closing) {
      StopCurrentAudio();
    }
  }

private:
  struct AudioQueueItem {
    std::string url;
    std::string turn_id;
    bool has_motion = false;
    ag99::runtime::Json motion_payload = ag99::runtime::Json::object();
  };

  void OnSegment(ag99::runtime::OutputSegment segment) {
    if (closing_.load()) {
      return;
    }
    if (segment.text.state == ag99::runtime::TextSlot::State::Present) {
      std::cout << "[assistant] " << segment.text.content << '\n';
    }
    auto turn_id = segment.envelope.turn_id.value_or("");
    if (segment.audio.state == ag99::runtime::AudioSlot::State::Present) {
      AudioQueueItem item;
      item.url = std::move(segment.audio.url);
      item.turn_id = std::move(turn_id);
      if (segment.motion.state == ag99::runtime::MotionSlot::State::Present) {
        item.has_motion = true;
        item.motion_payload = std::move(segment.motion.payload);
      }
      {
        std::scoped_lock lock(audio_queue_mutex_);
        if (closing_.load()) {
          return;
        }
        audio_queue_.push_back(std::move(item));
      }
      audio_queue_condition_.notify_one();
      return;
    }

    if (segment.motion.state == ag99::runtime::MotionSlot::State::Present
        && on_motion_intent_) {
      on_motion_intent_(segment.motion.payload, turn_id);
    }
    if (!turn_id.empty() && websocket_.connected()) {
      const auto finished =
          ag99::runtime::build_control_playback_finished(turn_id);
      websocket_.send_text(finished.dump());
    }
  }

  void AudioWorkerLoop() {
    while (true) {
      AudioQueueItem item;
      {
        std::unique_lock lock(audio_queue_mutex_);
        audio_queue_condition_.wait(lock, [this] {
          return closing_.load() || !audio_queue_.empty();
        });
        if (closing_.load()) {
          return;
        }
        item = std::move(audio_queue_.front());
        audio_queue_.pop_front();
      }

      const auto playback = PlayAudioUrl(item.url);
      if (!playback) {
        SendPlaybackFinished(
            item.turn_id,
            false,
            std::string_view{"audio_download_failed"});
        continue;
      }

      if (closing_.load()) {
        continue;
      }
      if (item.has_motion && on_motion_intent_) {
        on_motion_intent_(item.motion_payload, item.turn_id);
      }
      const auto deadline = NowSeconds() + playback->duration_seconds;
      while (!closing_.load()
             && g_audio_serial.load() == playback->serial
             && NowSeconds() < deadline) {
        std::this_thread::sleep_for(std::chrono::milliseconds(25));
      }
      if (closing_.load()
          || g_audio_serial.load() != playback->serial) {
        continue;
      }
      SendPlaybackFinished(item.turn_id);
    }
  }

  void SendPlaybackFinished(
      const std::string& turn_id,
      bool success = true,
      std::optional<std::string_view> reason = std::nullopt) {
    if (closing_.load() || turn_id.empty()) {
      return;
    }
    const auto finished = ag99::runtime::build_control_playback_finished(
        turn_id,
        success,
        reason);
    websocket_.send_text(finished.dump());
  }

  ag99::runtime::WinHttpWebSocketClient websocket_;
  MicrophoneCapture microphone_;
  std::function<void(ag99::runtime::ModelSync)> on_model_sync_;
  std::function<void(const ag99::runtime::Json&, const std::string&)> on_motion_intent_;
  std::function<void(const std::string&)> on_turn_started_;
  std::function<void(const std::string&)> on_turn_finished_;
  ag99::runtime::RuntimeProtocolSession session_;
  std::mutex audio_queue_mutex_;
  std::condition_variable audio_queue_condition_;
  std::deque<AudioQueueItem> audio_queue_;
  std::atomic<bool> closing_{false};
  std::thread audio_worker_;
  std::atomic<std::uint64_t> next_turn_id_{1};
};

const std::filesystem::path& ExecutableDirectory() {
  static const std::filesystem::path directory = [] {
    std::wstring buffer(32768, L'\0');
    const DWORD length = GetModuleFileNameW(
        nullptr, buffer.data(), static_cast<DWORD>(buffer.size()));
    if (length == 0
        || static_cast<std::size_t>(length) >= buffer.size()) {
      return std::filesystem::path{};
    }
    buffer.resize(length);
    return std::filesystem::path(buffer).parent_path();
  }();
  return directory;
}

csmByte* LoadFile(const std::string path, csmSizeInt* size) {
  if (path.empty() || !size) {
    return nullptr;
  }

  constexpr std::string_view shader_prefix = "FrameworkShaders/";
  const bool is_shader = path.rfind(shader_prefix.data(), 0) == 0;
  const std::filesystem::path relative_shader =
      is_shader
      ? std::filesystem::path(path.substr(shader_prefix.size()))
      : std::filesystem::path{};

  // Prefer assets shipped next to the executable so a packaged build does not
  // depend on the SDK location that happened to be configured at compile time.
  const std::filesystem::path local_shader =
      is_shader ? ExecutableDirectory() / relative_shader
                : std::filesystem::path{};
  if (is_shader && !local_shader.empty()) {
    std::error_code error;
    if (std::filesystem::is_regular_file(local_shader, error)) {
      if (FILE* file = std::fopen(local_shader.string().c_str(), "rb")) {
        std::fseek(file, 0, SEEK_END);
        const long length = std::ftell(file);
        std::fseek(file, 0, SEEK_SET);
        if (length > 0) {
          auto* buffer = static_cast<csmByte*>(
              std::malloc(static_cast<std::size_t>(length)));
          if (buffer && std::fread(
                  buffer, 1, static_cast<std::size_t>(length), file)
                  == static_cast<std::size_t>(length)) {
            std::fclose(file);
            *size = static_cast<csmSizeInt>(length);
            return buffer;
          }
          std::free(buffer);
        }
        std::fclose(file);
      }
    }
  }

  std::filesystem::path resolved_path = path;
  if (is_shader && !g_shader_directory.empty()) {
    resolved_path = g_shader_directory / relative_shader;
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
    _renderer.Shutdown();
    if (_model) {
      delete _model;
      _model = nullptr;
    }
    delete _setting;
    _setting = nullptr;

  }

  bool Load(
      const std::filesystem::path& model_json,
      UINT width,
      UINT height,
      ID3D11Device* device,
      ID3D11DeviceContext* context) {
    _width = width;
    _height = height;
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
    _model->LoadConfiguredEffects(model_dir, _setting);

    if (!_renderer.Initialize(
            *_model, *_setting, device, context, model_dir,
            width, height)) {
      return false;
    }

    csmMap<csmString, csmFloat32> layout;
    _setting->GetLayoutMap(layout);
    _model->GetModelMatrix()->SetupFromLayout(layout);
    if (_width < _height && _model->GetModel()->GetCanvasWidth() > 1.0f) {
      // Match the Native SDK's portrait-window layout correction once.
      _model->GetModelMatrix()->SetWidth(2.0f);
    }

    if (!_model->LoadDemoMotions(model_dir, _setting)) {
      std::cerr << "[cubism] demo motion groups are unavailable; "
                   "rendering will continue without motion playback\n";
    }

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
    _model->UpdateMotion(delta_seconds);
    ApplyQueuedMotion();
    _model->ApplyDrag(g_drag_x.load(), g_drag_y.load());
    UpdateAudioLevel(delta_seconds);
    ApplyParameterFrame(
        g_lip_sync_intensity.load(),
        g_audio_end_seconds.load() > NowSeconds(),
        delta_seconds);
    _model->UpdatePhysicsAndPose(delta_seconds);
    cubism_model->Update();

    _renderer.Draw();
  }

  void SetModelSync(const ag99::runtime::Json& payload) {
    std::scoped_lock lock(_motion_mutex);
    const auto* previous_profile = SelectedModelProfile(_model_sync_payload);
    const auto* next_profile = SelectedModelProfile(payload);
    const bool selected_runtime_changed =
        SelectedModelName(_model_sync_payload) != SelectedModelName(payload)
        || (previous_profile == nullptr) != (next_profile == nullptr)
        || (previous_profile && next_profile
            && *previous_profile != *next_profile);
    _model_sync_payload = payload;
    if (selected_runtime_changed) {
      _interaction_sway.reset();
      _interaction_gaze.reset();
      _pending_thinking_turn_id.reset();
      _gaze_candidate_valid = false;
      _gaze_candidate_since_ms = 0.0;
    }
    std::unordered_set<std::string> protected_parameter_ids;
    const auto model_info = payload.find("model_info");
    if (model_info != payload.end() && model_info->is_object()) {
      const auto models = model_info->find("models");
      const auto selected_model = ReadString(*model_info, "selected_model");
      if (models != model_info->end() && models->is_array()) {
        for (const auto& model : *models) {
          if (!model.is_object()
              || (!selected_model.empty()
                  && ReadString(model, "name") != selected_model)) {
            continue;
          }
          const auto profile = model.find("semantic_axis_profile");
          if (profile == model.end() || !profile->is_object()) {
            continue;
          }
          const auto axes = profile->find("axes");
          if (axes == profile->end() || !axes->is_array()) {
            continue;
          }
          for (const auto& axis : *axes) {
            if (!axis.is_object()) {
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
              const auto parameter_id = binding.find("parameter_id");
              if (parameter_id != binding.end()
                  && parameter_id->is_string()
                  && !parameter_id->get<std::string>().empty()) {
                protected_parameter_ids.insert(
                    parameter_id->get<std::string>());
              }
            }
          }
        }
      }
    }
    if (_model) {
      _model->SetPhysicsResponseProtectedParameterIds(protected_parameter_ids);
    }
    std::cerr << "[motion] model sync received\n";
  }

  void QueueMotionPayload(
      const ag99::runtime::Json& payload,
      const std::string& turn_id) {
    std::scoped_lock lock(_motion_mutex);
    const auto schema = ReadString(payload, "schema_version");
    if (schema == std::string(ag99::runtime::kParameterPlanSchema)) {
      _pending_parameter_plan = payload;
      _pending_parameter_plan_turn_id = turn_id;
      _pending_motion_intent.reset();
      _pending_motion_intent_turn_id.reset();
      _active_motion.reset();
      std::cerr << "[motion] parameter plan queued\n";
      return;
    }
    _pending_motion_intent = payload;
    _pending_motion_intent_turn_id = turn_id;
    _pending_parameter_plan.reset();
    _pending_parameter_plan_turn_id.reset();
    _active_parameter_plan.reset();
    std::cerr << "[motion] intent queued\n";
  }

  void StartThinkingSway(const std::string& turn_id) {
    if (turn_id.empty()) {
      return;
    }
    std::scoped_lock lock(_motion_mutex);
    _pending_thinking_turn_id = turn_id;
  }

  void ReleaseThinkingSway(const std::string& turn_id) {
    std::scoped_lock lock(_motion_mutex);
    if (_interaction_sway
        && (turn_id.empty() || _interaction_sway->turn_id == turn_id)) {
      ReleaseThinkingSwayLocked(turn_id);
    }
    if (_pending_thinking_turn_id
        && (turn_id.empty() || *_pending_thinking_turn_id == turn_id)) {
      _pending_thinking_turn_id.reset();
    }
  }

  void UpdateCursorGaze(
      HWND window) {
    if (!window || !IsWindowVisible(window)) {
      return;
    }
    const double now_ms = NowSeconds() * 1000.0;
    if (now_ms < _next_cursor_poll_ms) {
      return;
    }
    _next_cursor_poll_ms = now_ms + 100.0;

    POINT cursor{};
    RECT bounds{};
    if (!GetCursorPos(&cursor) || !GetWindowRect(window, &bounds)) {
      return;
    }
    const double window_width = std::max<LONG>(1, bounds.right - bounds.left);
    const double window_center_x = bounds.left + window_width * 0.5;

    const double target_ratio = Clamp(
        (cursor.x - window_center_x) / std::max(1.0, window_width * 1.5),
        -1.0,
        1.0);
    std::scoped_lock lock(_motion_mutex);
    const bool moved = !_gaze_candidate_valid
        || std::hypot(cursor.x - _gaze_candidate_x,
                      cursor.y - _gaze_candidate_y) > 14.0;
    if (moved) {
      _gaze_candidate_valid = true;
      _gaze_candidate_x = cursor.x;
      _gaze_candidate_y = cursor.y;
      _gaze_candidate_since_ms = now_ms;
      if (_interaction_gaze) {
        _interaction_gaze->target_ratio = 0.0;
      }
      return;
    }

    _gaze_candidate_x = cursor.x;
    _gaze_candidate_y = cursor.y;
    if (now_ms - _gaze_candidate_since_ms < 450.0) {
      return;
    }
    if (!_interaction_gaze) {
      auto state = CreateInteractionGaze(target_ratio);
      if (state) {
        _interaction_gaze = std::move(*state);
        std::cerr << "[interaction] cursor gaze started\n";
      }
      return;
    }
    _interaction_gaze->target_ratio = target_ratio;
  }

private:
  struct MotionTrack {
    struct Keyframe {
      int at_ms = 0;
      float target_value = 0.0f;
    };

    csmInt32 parameter_index = -1;
    float neutral_value = 0.0f;
    int start_at_ms = 0;
    std::vector<Keyframe> keyframes;
  };

  struct MotionPlan {
    double started_at = 0.0;
    int duration_ms = 900;
    int blend_in_ms = 120;
    int blend_out_ms = 180;
    std::vector<MotionTrack> tracks;
  };

  struct ParameterPlanTrackPoint {
    int at_ms = 0;
    int transition_ms = 0;
    float value = 0.0f;
  };

  struct ParameterPresentationState {
    float initial_value = 0.0f;
    float neutral_value = 0.0f;
    float max_velocity = 1.0f;
    float max_acceleration = 1.0f;
    std::string response_kind = "bounded";
    float response_frequency_hz = 0.0f;
    float response_damping_ratio = 0.0f;
    float driven_offset = 0.0f;
    float velocity = 0.0f;
    double last_elapsed_ms = -1.0;
  };

  struct ParameterPlanBinding {
    std::string axis_id;
    std::string parameter_id;
    csmInt32 parameter_index = -1;
    int activation_at_ms = 0;
    float target_value = 0.0f;
    float neutral_target_value = 0.0f;
    float weight = 1.0f;
    std::vector<ParameterPlanTrackPoint> keyframes;
    std::vector<ParameterPlanTrackPoint> modulation_points;
    float modulation_amplitude = 0.0f;
    int modulation_direction = 1;
    int modulation_delay_ms = 0;
    float max_speech_offset = 0.0f;
    ParameterPresentationState presentation;
  };

  struct InteractionBinding {
    std::string axis_id;
    std::string parameter_id;
    csmInt32 parameter_index = -1;
    float neutral_value = 0.0f;
    float negative_value = 0.0f;
    float positive_value = 0.0f;
    float weight = 1.0f;
    ParameterPresentationState presentation;
  };

  struct InteractionSwayState {
    std::string turn_id;
    double cycle_ms = 4000.0;
    double attack_ms = 500.0;
    double release_ms = 650.0;
    double elapsed_ms = 0.0;
    std::optional<double> release_started_at_ms;
    std::vector<InteractionBinding> bindings;
  };

  struct InteractionGazeState {
    double target_ratio = 0.0;
    double elapsed_ms = 0.0;
    std::vector<InteractionBinding> bindings;
  };

  struct ParameterPlan {
    double started_at = 0.0;
    int duration_ms = 0;
    int blend_in_ms = 0;
    int hold_ms = 0;
    int blend_out_ms = 0;
    std::string curve_preset = "smooth_hold";
    std::string expression_id;
    double release_started_at_ms = -1.0;
    std::vector<ParameterPlanBinding> bindings;
  };

  enum class ParameterContributionOwner {
    InteractionSway,
    InteractionGaze,
    DirectPlan,
    LipSync,
  };

  struct ParameterFrameContribution {
    std::string parameter_id;
    csmInt32 parameter_index = -1;
    ParameterContributionOwner owner = ParameterContributionOwner::DirectPlan;
    std::string source;
    float value = 0.0f;
    float weight = 1.0f;
    int priority = 0;
    ParameterPresentationState* presentation = nullptr;
    bool presentation_is_direct_plan = false;
    double elapsed_ms = 0.0;
  };

  struct ParameterFrameSnapshot {
    std::string parameter_id;
    float base_value = 0.0f;
    float minimum_value = 0.0f;
    float maximum_value = 0.0f;
  };

  struct ParameterFrameGroup {
    csmInt32 parameter_index = -1;
    std::string parameter_id;
    std::vector<ParameterFrameContribution*> contributions;
    ParameterFrameSnapshot snapshot;
  };

  static double Clamp(double value, double minimum, double maximum) {
    return std::max(minimum, std::min(maximum, value));
  }

  static float Smoothstep(float value) {
    const auto clamped = std::clamp(value, 0.0f, 1.0f);
    return clamped * clamped * (3.0f - 2.0f * clamped);
  }

  static std::string ParameterIdRaw(
      CubismModel* model,
      csmInt32 parameter_index) {
    if (!model || parameter_index < 0
        || parameter_index >= model->GetParameterCount()) {
      return {};
    }
    const auto parameter_id = model->GetParameterId(
        static_cast<csmUint32>(parameter_index));
    if (!parameter_id) {
      return {};
    }
    return parameter_id->GetString().GetRawString();
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

  static bool HasOnlyKeys(
      const ag99::runtime::Json& object,
      std::initializer_list<const char*> keys) {
    if (!object.is_object()) {
      return false;
    }
    for (const auto& [key, _] : object.items()) {
      bool allowed = false;
      for (const auto* candidate : keys) {
        if (key == candidate) {
          allowed = true;
          break;
        }
      }
      if (!allowed) {
        return false;
      }
    }
    return true;
  }

  static bool IsFiniteNumber(const ag99::runtime::Json& value) {
    return value.is_number() && std::isfinite(value.get<double>());
  }

  static bool IsIntegerInRange(
      const ag99::runtime::Json& value,
      int minimum,
      int maximum) {
    return value.is_number_integer()
        && value.get<std::int64_t>() >= minimum
        && value.get<std::int64_t>() <= maximum;
  }

  static std::optional<ParameterPlanTrackPoint> ParseTrackPoint(
      const ag99::runtime::Json& value,
      int duration_ms,
      bool modulation) {
    const bool valid_shape = modulation
        ? HasOnlyKeys(value, {"at_ms", "transition_ms", "value"})
        : HasOnlyKeys(value, {"at_ms", "transition_ms", "target_value", "input_value"});
    if (!value.is_object() || !valid_shape) {
      return std::nullopt;
    }
    const auto at = value.find("at_ms");
    const auto transition = value.find("transition_ms");
    const char* value_key = modulation ? "value" : "target_value";
    const auto target = value.find(value_key);
    if (at == value.end() || transition == value.end() || target == value.end()
        || !IsIntegerInRange(*at, 0, duration_ms)
        || !IsIntegerInRange(*transition, 0, duration_ms)
        || !IsFiniteNumber(*target)) {
      return std::nullopt;
    }
    const auto at_ms = static_cast<int>(at->get<std::int64_t>());
    const auto transition_ms = static_cast<int>(transition->get<std::int64_t>());
    if (at_ms + transition_ms > duration_ms) {
      return std::nullopt;
    }
    return ParameterPlanTrackPoint{
        at_ms,
        transition_ms,
        static_cast<float>(target->get<double>())};
  }

  std::optional<ParameterPlan> ParseParameterPlan(
      const ag99::runtime::Json& payload) const {
    if (!payload.is_object()
        || ReadString(payload, "schema_version")
            != std::string(ag99::runtime::kParameterPlanSchema)
        || !HasOnlyKeys(payload, {
             "schema_version", "profile_id", "profile_revision", "model_id",
             "mode", "emotion_label", "resource", "timing", "parameters",
             "diagnostics", "summary"})) {
      return std::nullopt;
    }
    const auto profile = SelectedModelProfile();
    if (!profile) {
      std::cerr << "[motion] parameter plan profile is unavailable\n";
      return std::nullopt;
    }
    const auto profile_id = ReadString(*profile, "profile_id");
    const auto model_id = ReadString(*profile, "model_id");
    if ((!profile_id.empty() && ReadString(payload, "profile_id") != profile_id)
        || (!model_id.empty() && ReadString(payload, "model_id") != model_id)) {
      std::cerr << "[motion] parameter plan profile/model mismatch\n";
      return std::nullopt;
    }
    const auto revision = payload.find("profile_revision");
    if (revision == payload.end() || !revision->is_number_integer()
        || revision->get<std::int64_t>() <= 0) {
      return std::nullopt;
    }
    if (const auto profile_revision = profile->find("revision");
        profile_revision != profile->end() && profile_revision->is_number_integer()
        && revision->get<std::int64_t>() != profile_revision->get<std::int64_t>()) {
      std::cerr << "[motion] parameter plan profile revision mismatch\n";
      return std::nullopt;
    }
    const auto mode = ReadString(payload, "mode");
    if (mode != "idle" && mode != "expressive"
        || ReadString(payload, "emotion_label").empty()) {
      return std::nullopt;
    }
    const auto timing = payload.find("timing");
    if (timing == payload.end() || !timing->is_object()
        || !HasOnlyKeys(*timing, {
             "duration_ms", "blend_in_ms", "hold_ms", "blend_out_ms", "curve_preset"})) {
      return std::nullopt;
    }
    const auto duration = timing->find("duration_ms");
    const auto blend_in = timing->find("blend_in_ms");
    const auto hold = timing->find("hold_ms");
    const auto blend_out = timing->find("blend_out_ms");
    if (duration == timing->end() || blend_in == timing->end()
        || hold == timing->end() || blend_out == timing->end()
        || !IsIntegerInRange(*duration, 320, 15000)
        || !IsIntegerInRange(*blend_in, 0, 15000)
        || !IsIntegerInRange(*hold, 0, 15000)
        || !IsIntegerInRange(*blend_out, 0, 15000)) {
      return std::nullopt;
    }
    const int duration_ms = static_cast<int>(duration->get<std::int64_t>());
    const int blend_in_ms = static_cast<int>(blend_in->get<std::int64_t>());
    const int hold_ms = static_cast<int>(hold->get<std::int64_t>());
    const int blend_out_ms = static_cast<int>(blend_out->get<std::int64_t>());
    if (blend_in_ms + hold_ms + blend_out_ms != duration_ms) {
      return std::nullopt;
    }
    ParameterPlan plan{
        .started_at = NowSeconds(),
        .duration_ms = duration_ms,
        .blend_in_ms = blend_in_ms,
        .hold_ms = hold_ms,
        .blend_out_ms = blend_out_ms,
        .curve_preset = ReadString(*timing, "curve_preset"),
    };
    if (plan.curve_preset.empty()) {
      plan.curve_preset = "smooth_hold";
    }
    static constexpr std::array<std::string_view, 5> kCurves = {
        "smooth_hold", "snap_hold_soft_release", "slow_build_quick_release",
        "pulse_settle", "breathing_swell"};
    if (std::find(kCurves.begin(), kCurves.end(), plan.curve_preset)
        == kCurves.end()) {
      return std::nullopt;
    }

    std::unordered_set<std::string> resource_parameter_ids;
    if (const auto resource = payload.find("resource");
        resource != payload.end() && !resource->is_null()) {
      if (!resource->is_object()
          || !HasOnlyKeys(*resource, {
               "kind", "resource_id", "expression_id", "parameter_ids"})
          || ReadString(*resource, "kind") != "expression"
          || ReadString(*resource, "resource_id").empty()
          || ReadString(*resource, "expression_id").empty()
          || !resource->contains("parameter_ids")
          || !resource->at("parameter_ids").is_array()
          || resource->at("parameter_ids").empty()) {
        return std::nullopt;
      }
      for (const auto& parameter_id : resource->at("parameter_ids")) {
        if (!parameter_id.is_string()
            || parameter_id.get<std::string>().empty()) {
          return std::nullopt;
        }
        resource_parameter_ids.insert(parameter_id.get<std::string>());
      }
      plan.expression_id = ReadString(*resource, "expression_id");
    }

    const auto parameters = payload.find("parameters");
    if (parameters == payload.end() || !parameters->is_array()
        || parameters->empty()) {
      return std::nullopt;
    }
    std::unordered_set<std::string> parameter_ids;
    for (const auto& item : *parameters) {
      if (!item.is_object()
          || !HasOnlyKeys(item, {
               "axis_id", "parameter_id", "activation_at_ms", "target_value",
               "neutral_target_value", "weight", "input_value", "source",
               "keyframes", "modulation", "dynamics"})) {
        return std::nullopt;
      }
      const auto axis_id = ReadString(item, "axis_id");
      const auto parameter_id = ReadString(item, "parameter_id");
      const auto activation = item.find("activation_at_ms");
      const auto target = item.find("target_value");
      const auto neutral = item.find("neutral_target_value");
      const auto weight = item.find("weight");
      const auto source = ReadString(item, "source");
      static constexpr std::array<std::string_view, 6> kSources = {
          "semantic_axis", "relation_graph", "speech_pose",
          "expression", "continuity", "manual"};
      if (axis_id.empty() || parameter_id.empty()
          || !parameter_ids.insert(parameter_id).second
          || activation == item.end() || target == item.end()
          || neutral == item.end() || weight == item.end()
          || !IsIntegerInRange(*activation, 0, duration_ms)
          || !IsFiniteNumber(*target) || !IsFiniteNumber(*neutral)
          || !IsFiniteNumber(*weight) || weight->get<double>() < 0.0
          || weight->get<double>() > 1.0
          || std::find(kSources.begin(), kSources.end(), source) == kSources.end()) {
        return std::nullopt;
      }
      const auto dynamics = item.find("dynamics");
      if (dynamics == item.end() || !dynamics->is_object()
          || !HasOnlyKeys(*dynamics, {
               "max_velocity", "max_acceleration", "max_speech_offset", "response"})) {
        return std::nullopt;
      }
      const auto max_velocity = dynamics->find("max_velocity");
      const auto max_acceleration = dynamics->find("max_acceleration");
      const auto max_speech_offset = dynamics->find("max_speech_offset");
      const auto response = dynamics->find("response");
      if (max_velocity == dynamics->end() || max_acceleration == dynamics->end()
          || max_speech_offset == dynamics->end() || response == dynamics->end()
          || !IsFiniteNumber(*max_velocity) || max_velocity->get<double>() <= 0
          || !IsFiniteNumber(*max_acceleration) || max_acceleration->get<double>() <= 0
          || !IsFiniteNumber(*max_speech_offset) || max_speech_offset->get<double>() < 0
          || !response->is_object()) {
        return std::nullopt;
      }
      ParameterPlanBinding binding{
          .axis_id = axis_id,
          .parameter_id = parameter_id,
          .activation_at_ms = static_cast<int>(activation->get<std::int64_t>()),
          .target_value = static_cast<float>(target->get<double>()),
          .neutral_target_value = static_cast<float>(neutral->get<double>()),
          .weight = static_cast<float>(weight->get<double>()),
          .max_speech_offset = static_cast<float>(max_speech_offset->get<double>()),
          .presentation = ParameterPresentationState{
              .max_velocity = static_cast<float>(max_velocity->get<double>()),
              .max_acceleration = static_cast<float>(max_acceleration->get<double>()),
          },
      };
      const auto response_kind = ReadString(*response, "kind");
      if (response_kind == "bounded") {
        if (!HasOnlyKeys(*response, {"kind"})) {
          return std::nullopt;
        }
      } else if (response_kind == "spring") {
        if (!HasOnlyKeys(*response, {"kind", "frequency_hz", "damping_ratio"})
            || !response->contains("frequency_hz")
            || !response->contains("damping_ratio")
            || !IsFiniteNumber(response->at("frequency_hz"))
            || !IsFiniteNumber(response->at("damping_ratio"))
            || response->at("frequency_hz").get<double>() <= 0
            || response->at("frequency_hz").get<double>() > 10
            || response->at("damping_ratio").get<double>() < 0.5
            || response->at("damping_ratio").get<double>() >= 1) {
          return std::nullopt;
        }
        binding.presentation.response_frequency_hz =
            static_cast<float>(response->at("frequency_hz").get<double>());
        binding.presentation.response_damping_ratio =
            static_cast<float>(response->at("damping_ratio").get<double>());
      } else {
        return std::nullopt;
      }
      binding.presentation.response_kind = response_kind;

      if (const auto keyframes = item.find("keyframes");
          keyframes != item.end()) {
        if (!keyframes->is_array() || keyframes->size() < 2
            || keyframes->size() > 4) {
          return std::nullopt;
        }
        int previous_at = -1;
        int previous_end = -1;
        for (const auto& point : *keyframes) {
          const auto parsed = ParseTrackPoint(
              point, duration_ms, false);
          if (!parsed || parsed->at_ms <= previous_at
              || parsed->at_ms < previous_end) {
            return std::nullopt;
          }
          previous_at = parsed->at_ms;
          previous_end = parsed->at_ms + parsed->transition_ms;
          binding.keyframes.push_back(*parsed);
        }
        if (binding.keyframes.front().at_ms != binding.activation_at_ms
            || binding.keyframes.front().transition_ms != 0) {
          return std::nullopt;
        }
      }
      if (const auto modulation = item.find("modulation");
          modulation != item.end()) {
        if (!modulation->is_object()
            || !HasOnlyKeys(*modulation, {
                 "kind", "preset", "amplitude", "direction", "delay_ms", "points"})
            || ReadString(*modulation, "kind") != "speech_gesture_track"
            || (ReadString(*modulation, "preset") != "calm_explain"
                && ReadString(*modulation, "preset") != "lively_chat"
                && ReadString(*modulation, "preset") != "gentle_support"
                && ReadString(*modulation, "preset") != "emphatic")
            || !modulation->contains("amplitude")
            || !modulation->contains("direction")
            || !modulation->contains("delay_ms")
            || !modulation->contains("points")
            || !IsFiniteNumber(modulation->at("amplitude"))
            || modulation->at("amplitude").get<double>() < 0
            || (modulation->at("direction") != 1
                && modulation->at("direction") != -1)
            || !IsIntegerInRange(modulation->at("delay_ms"), 0, 600)
            || !modulation->at("points").is_array()
            || modulation->at("points").size() < 3
            || modulation->at("points").size() > 8) {
          return std::nullopt;
        }
        binding.modulation_amplitude =
            std::min(
                binding.max_speech_offset,
                static_cast<float>(modulation->at("amplitude").get<double>()));
        binding.modulation_direction =
            modulation->at("direction").get<int>();
        binding.modulation_delay_ms =
            static_cast<int>(modulation->at("delay_ms").get<std::int64_t>());
        int previous_at = -1;
        int previous_end = -1;
        for (const auto& point : modulation->at("points")) {
          const auto parsed = ParseTrackPoint(point, duration_ms, true);
          if (!parsed || parsed->at_ms <= previous_at
              || parsed->at_ms < previous_end
              || parsed->at_ms + parsed->transition_ms
                   + binding.modulation_delay_ms > duration_ms) {
            return std::nullopt;
          }
          previous_at = parsed->at_ms;
          previous_end = parsed->at_ms + parsed->transition_ms;
          binding.modulation_points.push_back(*parsed);
        }
        if (binding.modulation_points.front().at_ms != 0
            || binding.modulation_points.front().transition_ms != 0
            || std::abs(binding.modulation_points.front().value) > 1e-6f) {
          return std::nullopt;
        }
      }
      const auto parameter_id_handle =
          CubismFramework::GetIdManager()->GetId(parameter_id.c_str());
      binding.parameter_index = _model->GetModel()->GetParameterIndex(
          parameter_id_handle);
      if (binding.parameter_index < 0) {
        std::cerr << "[motion] parameter plan parameter is missing: "
                  << parameter_id << '\n';
        return std::nullopt;
      }
      const auto minimum = _model->GetModel()->GetParameterMinimumValue(
          binding.parameter_index);
      const auto maximum = _model->GetModel()->GetParameterMaximumValue(
          binding.parameter_index);
      if (binding.target_value < minimum || binding.target_value > maximum
          || binding.neutral_target_value < minimum
          || binding.neutral_target_value > maximum) {
        return std::nullopt;
      }
      binding.presentation.initial_value = _model->GetModel()->GetParameterValue(
          binding.parameter_index);
      binding.presentation.neutral_value = binding.neutral_target_value;
      for (const auto& point : binding.keyframes) {
        if (point.value < minimum || point.value > maximum) {
          return std::nullopt;
        }
      }
      if (resource_parameter_ids.contains(parameter_id)) {
        return std::nullopt;
      }
      plan.bindings.push_back(std::move(binding));
    }
    if (plan.bindings.empty()) {
      return std::nullopt;
    }
    return plan;
  }

  static float ResolveTrack(
      const std::vector<ParameterPlanTrackPoint>& points,
      double elapsed_ms,
      float fallback) {
    if (points.size() < 2) {
      return fallback;
    }
    auto previous = points.front();
    for (std::size_t index = 1; index < points.size(); ++index) {
      const auto next = points[index];
      if (elapsed_ms < next.at_ms) {
        return previous.value;
      }
      const auto transition_end = next.at_ms + next.transition_ms;
      if (next.transition_ms > 0 && elapsed_ms < transition_end) {
        const auto t = static_cast<float>(
            std::clamp((elapsed_ms - next.at_ms) / next.transition_ms, 0.0, 1.0));
        return previous.value + (next.value - previous.value) * t;
      }
      previous = next;
    }
    return previous.value;
  }

  static float ClampFloat(float value, float minimum, float maximum) {
    return std::max(minimum, std::min(maximum, value));
  }

  struct DynamicsState {
    float value = 0.0f;
    float velocity = 0.0f;
  };

  static DynamicsState AdvanceBounded(
      float previous,
      float target,
      float velocity,
      float delta_seconds,
      float max_velocity,
      float max_acceleration) {
    const float remaining = target - previous;
    const float velocity_delta = max_acceleration * delta_seconds;
    if (std::abs(remaining) <= 0.001f
        && std::abs(velocity) <= velocity_delta) {
      return {target, 0.0f};
    }
    const float direction = remaining == 0.0f ? 0.0f : remaining > 0 ? 1.0f : -1.0f;
    const float braking_speed = std::sqrt(
        std::max(0.0f, 2.0f * max_acceleration * std::abs(remaining)));
    const float desired_velocity = direction
        * std::min(max_velocity, braking_speed);
    const float next_velocity = ClampFloat(
        desired_velocity,
        velocity - velocity_delta,
        velocity + velocity_delta);
    const float next_value = previous + next_velocity * delta_seconds;
    if (direction != 0.0f
        && ((target - next_value > 0) != (direction > 0))) {
      return {target, 0.0f};
    }
    if (std::abs(target - next_value) <= 0.001f
        && std::abs(next_velocity) <= velocity_delta
    ) {
      return {target, 0.0f};
    }
    return {next_value, next_velocity};
  }

  static float ResolveDampedSpringVelocity(
      float previous,
      float target,
      float velocity,
      float delta_seconds,
      float frequency_hz,
      float damping_ratio) {
    const float displacement = previous - target;
    const float angular_frequency =
        2.0f * 3.14159265358979323846f * frequency_hz;
    const float damped_frequency = angular_frequency
        * std::sqrt(std::max(0.0f, 1.0f - damping_ratio * damping_ratio));
    if (damped_frequency <= 1e-6f) {
      return 0.0f;
    }
    const float decay = std::exp(
        -damping_ratio * angular_frequency * delta_seconds);
    const float phase = damped_frequency * delta_seconds;
    const float cosine = std::cos(phase);
    const float sine = std::sin(phase);
    const float velocity_term =
        (velocity + damping_ratio * angular_frequency * displacement)
        / damped_frequency;
    const float projected_displacement =
        displacement * cosine + velocity_term * sine;
    return decay * (
        -damping_ratio * angular_frequency * projected_displacement
        - displacement * damped_frequency * sine
        + velocity_term * damped_frequency * cosine);
  }

  static DynamicsState AdvanceSpringStep(
      float previous,
      float target,
      float velocity,
      float delta_seconds,
      float max_velocity,
      float max_acceleration,
      float frequency_hz,
      float damping_ratio) {
    const float remaining = target - previous;
    const float velocity_delta = max_acceleration * delta_seconds;
    if (std::abs(remaining) <= 0.001f
        && std::abs(velocity) <= velocity_delta) {
      return {target, 0.0f};
    }
    const float desired_velocity = ResolveDampedSpringVelocity(
        previous, target, velocity, delta_seconds,
        frequency_hz, damping_ratio);
    const float acceleration_limited_velocity = ClampFloat(
        desired_velocity,
        velocity - velocity_delta,
        velocity + velocity_delta);
    const float next_velocity = ClampFloat(
        acceleration_limited_velocity, -max_velocity, max_velocity);
    const float next_value = previous
        + (velocity + next_velocity) * 0.5f * delta_seconds;
    if (std::abs(target - next_value) <= 0.001f
        && std::abs(next_velocity) <= velocity_delta) {
      return {target, 0.0f};
    }
    return {next_value, next_velocity};
  }

  static DynamicsState AdvanceSpring(
      float previous,
      float target,
      float velocity,
      float delta_seconds,
      float max_velocity,
      float max_acceleration,
      float frequency_hz,
      float damping_ratio) {
    const int steps = std::max(
        1, static_cast<int>(std::ceil(delta_seconds / (1.0f / 120.0f))));
    const float step_seconds = delta_seconds / steps;
    float value = previous;
    float current_velocity = velocity;
    for (int index = 0; index < steps; ++index) {
      const auto state = AdvanceSpringStep(
          value, target, current_velocity, step_seconds,
          max_velocity, max_acceleration, frequency_hz, damping_ratio);
      value = state.value;
      current_velocity = state.velocity;
    }
    return {value, current_velocity};
  }

  static float ResolveEnvelopeTarget(
      const ParameterPresentationState& presentation,
      float frame_target,
      double elapsed_ms,
      const ParameterPlan* plan) {
    if (!plan) {
      return frame_target;
    }
    const auto elapsed = std::max(0.0, elapsed_ms);
    if (plan->blend_in_ms > 0 && elapsed < plan->blend_in_ms) {
      const auto progress = static_cast<float>(elapsed / plan->blend_in_ms);
      if (plan->curve_preset == "slow_build_quick_release") {
        return presentation.initial_value
            + (frame_target - presentation.initial_value) * progress * progress;
      }
      if (plan->curve_preset == "pulse_settle") {
        const auto x = progress - 1.0f;
        const auto eased = 1.0f + 2.70158f * x * x * x + 1.70158f * x * x;
        return presentation.initial_value
            + (frame_target - presentation.initial_value)
                * std::min(1.08f, eased);
      }
    }
    if (elapsed < plan->blend_in_ms + plan->hold_ms
        && (plan->curve_preset == "breathing_swell"
            || plan->curve_preset == "pulse_settle")) {
      const auto progress = plan->hold_ms > 0
          ? static_cast<float>((elapsed - plan->blend_in_ms) / plan->hold_ms)
          : 1.0f;
      return presentation.neutral_value
          + (frame_target - presentation.neutral_value)
              * (1.0f - 0.06f * std::sin(3.14159265358979323846f * progress));
    }
    return frame_target;
  }

  void ReleaseThinkingSwayLocked(const std::string& turn_id) {
    if (_interaction_sway
        && (turn_id.empty() || _interaction_sway->turn_id == turn_id)
        && !_interaction_sway->release_started_at_ms) {
      _interaction_sway->release_started_at_ms = _interaction_sway->elapsed_ms;
    }
    if (_pending_thinking_turn_id
        && (turn_id.empty() || *_pending_thinking_turn_id == turn_id)) {
      _pending_thinking_turn_id.reset();
    }
  }

  void CollectInteractionContributions(
      float delta_seconds,
      std::vector<ParameterFrameContribution>& contributions) {
    const auto delta_ms = std::max(0.0f, delta_seconds) * 1000.0;
    if (_pending_thinking_turn_id) {
      const auto turn_id = *_pending_thinking_turn_id;
      _pending_thinking_turn_id.reset();
      auto state = CreateInteractionSway(turn_id);
      if (state) {
        _interaction_sway = std::move(*state);
        std::cerr << "[interaction] thinking sway started for turn "
                  << turn_id << '\n';
      } else {
        _interaction_sway.reset();
        std::cerr << "[interaction] no usable lateral semantic axis\n";
      }
    }

    if (_interaction_sway) {
      auto& sway = *_interaction_sway;
      sway.elapsed_ms += delta_ms;
      const auto release_elapsed_ms = sway.release_started_at_ms
          ? sway.elapsed_ms - *sway.release_started_at_ms
          : -1.0;
      if (release_elapsed_ms >= 0.0
          && (sway.release_ms <= 0.0 || release_elapsed_ms >= sway.release_ms)) {
        _interaction_sway.reset();
      } else {
        const auto attack_weight = sway.attack_ms <= 0.0
            ? 1.0f
            : Smoothstep(static_cast<float>(sway.elapsed_ms / sway.attack_ms));
        const auto release_weight = release_elapsed_ms < 0.0 || sway.release_ms <= 0.0
            ? 1.0f
            : Smoothstep(static_cast<float>(
                  1.0 - std::max(0.0, release_elapsed_ms) / sway.release_ms));
        const double phase = std::fmod(sway.elapsed_ms, sway.cycle_ms)
            / sway.cycle_ms;
        const float lateral_offset = static_cast<float>(
            std::sin(phase * 2.0 * 3.14159265358979323846));
        for (auto& binding : sway.bindings) {
          const float target = lateral_offset >= 0.0f
              ? binding.neutral_value
                  + (binding.positive_value - binding.neutral_value) * lateral_offset
              : binding.neutral_value
                  + (binding.negative_value - binding.neutral_value) * -lateral_offset;
          contributions.push_back(ParameterFrameContribution{
              binding.parameter_id,
              binding.parameter_index,
              ParameterContributionOwner::InteractionSway,
              "interaction_sway:" + binding.axis_id,
              target,
              binding.weight * attack_weight * release_weight,
              50,
              &binding.presentation,
              false,
              sway.elapsed_ms});
        }
      }
    }

    if (_interaction_gaze) {
      auto& gaze = *_interaction_gaze;
      gaze.elapsed_ms += delta_ms;
      const auto ratio = static_cast<float>(
          std::clamp(gaze.target_ratio, -1.0, 1.0));
      for (auto& binding : gaze.bindings) {
        const float target = ratio >= 0.0f
            ? binding.neutral_value
                + (binding.positive_value - binding.neutral_value) * ratio
            : binding.neutral_value
                + (binding.negative_value - binding.neutral_value) * -ratio;
        contributions.push_back(ParameterFrameContribution{
            binding.parameter_id,
            binding.parameter_index,
            ParameterContributionOwner::InteractionGaze,
            "interaction_gaze:" + binding.axis_id,
            target,
            binding.weight,
            60,
            &binding.presentation,
            false,
            gaze.elapsed_ms});
      }
    }
  }

  bool ApplyParameterFrame(
      float lip_sync_intensity,
      bool lip_sync_active,
      float delta_seconds) {
    std::scoped_lock lock(_motion_mutex);
    if (!_model || !_model->GetModel()) {
      return false;
    }
    if (_pending_parameter_plan) {
      const auto parsed = ParseParameterPlan(*_pending_parameter_plan);
      _pending_parameter_plan.reset();
      const auto turn_id = _pending_parameter_plan_turn_id.value_or("");
      _pending_parameter_plan_turn_id.reset();
      if (parsed) {
        if (!parsed->expression_id.empty()
            && !_model->StartExpressionById(parsed->expression_id)) {
          std::cerr << "[motion] expression resource not found: "
                    << parsed->expression_id << '\n';
          _active_parameter_plan.reset();
        } else {
          _active_parameter_plan = *parsed;
          ReleaseThinkingSwayLocked(turn_id);
          std::cerr << "[motion] activated parameter plan with "
                    << _active_parameter_plan->bindings.size()
                    << " bindings for "
                    << _active_parameter_plan->duration_ms << " ms\n";
        }
      } else {
        std::cerr << "[motion] parameter plan rejected\n";
      }
    }
    auto* cubism_model = _model->GetModel();
    std::vector<ParameterFrameContribution> contributions;
    CollectInteractionContributions(delta_seconds, contributions);
    double elapsed_ms = 0.0;
    bool clear_active_plan = false;

    if (_active_parameter_plan) {
      auto& plan = *_active_parameter_plan;
      elapsed_ms = (NowSeconds() - plan.started_at) * 1000.0;
      bool all_activated = true;
      for (const auto& binding : plan.bindings) {
        all_activated &= elapsed_ms >= binding.activation_at_ms;
      }
      if (plan.release_started_at_ms < 0.0
          && all_activated
          && elapsed_ms >= plan.duration_ms - plan.blend_out_ms) {
        plan.release_started_at_ms = elapsed_ms;
      }

      float ownership = 1.0f;
      if (plan.release_started_at_ms >= 0.0) {
        if (plan.blend_out_ms <= 0
            || elapsed_ms >= plan.release_started_at_ms + plan.blend_out_ms) {
          ownership = 0.0f;
        } else {
          const auto progress = static_cast<float>(
              (elapsed_ms - plan.release_started_at_ms) / plan.blend_out_ms);
          ownership = Smoothstep(1.0f - progress);
        }
      }

      for (auto& binding : plan.bindings) {
        if (elapsed_ms < binding.activation_at_ms) {
          continue;
        }
        auto frame_target = ResolveTrack(
            binding.keyframes, elapsed_ms, binding.target_value);
        if (!binding.modulation_points.empty()
            && binding.modulation_amplitude > 0.0f) {
          const auto gesture = ResolveTrack(
              binding.modulation_points,
              std::max(0.0, elapsed_ms - binding.modulation_delay_ms),
              0.0f);
          frame_target += gesture * binding.modulation_amplitude
              * static_cast<float>(binding.modulation_direction)
              * GetSpeechAudioGain(binding.axis_id);
        }
        contributions.push_back(ParameterFrameContribution{
            binding.parameter_id,
            binding.parameter_index,
            ParameterContributionOwner::DirectPlan,
            "direct_plan:" + binding.axis_id,
            frame_target,
            binding.weight * ownership,
            100,
            &binding.presentation,
            true,
            elapsed_ms});
      }
      clear_active_plan = plan.release_started_at_ms >= 0.0
          && elapsed_ms >= plan.release_started_at_ms + plan.blend_out_ms;
    }

    if (!std::isfinite(lip_sync_intensity)
        || lip_sync_intensity < 0.0f || lip_sync_intensity > 1.0f) {
      std::cerr << "[parameter_mixer] lip sync intensity invalid\n";
      return false;
    }
    if (lip_sync_active) {
      for (const auto parameter_index : _model->LipSyncParameterIndices()) {
        if (parameter_index < 0
            || parameter_index >= cubism_model->GetParameterCount()) {
          std::cerr << "[parameter_mixer] lip sync parameter is not writable\n";
          return false;
        }
        const auto minimum = cubism_model->GetParameterMinimumValue(
            static_cast<csmUint32>(parameter_index));
        const auto default_value = cubism_model->GetParameterDefaultValue(
            static_cast<csmUint32>(parameter_index));
        const auto maximum = cubism_model->GetParameterMaximumValue(
            static_cast<csmUint32>(parameter_index));
        if (!std::isfinite(minimum) || !std::isfinite(default_value)
            || !std::isfinite(maximum) || minimum > default_value
            || default_value >= maximum) {
          std::cerr << "[parameter_mixer] lip sync parameter range invalid: "
                    << ParameterIdRaw(cubism_model, parameter_index) << '\n';
          return false;
        }
        contributions.push_back(ParameterFrameContribution{
            ParameterIdRaw(cubism_model, parameter_index),
            parameter_index,
            ParameterContributionOwner::LipSync,
            "lip_sync",
            default_value + (maximum - default_value) * lip_sync_intensity,
            1.0f,
            200,
            nullptr,
            false,
            elapsed_ms});
      }
    }

    bool direct_presentation_settled = true;
    if (!ResolveAndWriteParameterFrame(
            contributions, direct_presentation_settled)) {
      return false;
    }
    if (clear_active_plan && direct_presentation_settled) {
      _active_parameter_plan.reset();
    }
    return true;
  }

  bool ResolveAndWriteParameterFrame(
      std::vector<ParameterFrameContribution>& contributions,
      bool& direct_presentation_settled) {
    auto* model = _model ? _model->GetModel() : nullptr;
    if (!model) {
      return false;
    }
    if (contributions.empty()) {
      return true;
    }

    const auto reject = [](const std::string& reason) {
      std::cerr << "[parameter_mixer] " << reason << '\n';
      return false;
    };
    std::vector<ParameterFrameGroup> groups;
    groups.reserve(contributions.size());
    std::unordered_map<csmInt32, std::size_t> group_by_index;
    for (auto& contribution : contributions) {
      if (contribution.parameter_id.empty()) {
        return reject("parameter_id_missing");
      }
      if (contribution.parameter_index < 0
          || contribution.parameter_index >= model->GetParameterCount()) {
        return reject("parameter_index_invalid:" + contribution.parameter_id);
      }
      if (contribution.source.empty() || !std::isfinite(contribution.value)
          || !std::isfinite(contribution.weight)
          || contribution.weight < 0.0f || contribution.weight > 1.0f) {
        return reject("contribution_invalid:" + contribution.parameter_id);
      }

      const auto [found, inserted] = group_by_index.emplace(
          contribution.parameter_index, groups.size());
      if (inserted) {
        groups.push_back(ParameterFrameGroup{
            contribution.parameter_index,
            contribution.parameter_id,
            {},
            {}});
      }
      auto& group = groups[found->second];
      if (group.parameter_id != contribution.parameter_id) {
        return reject("parameter_identity_conflict:" + group.parameter_id
            + ":" + contribution.parameter_id);
      }
      group.contributions.push_back(&contribution);
    }

    std::sort(groups.begin(), groups.end(), [](const auto& left, const auto& right) {
      return left.parameter_index < right.parameter_index;
    });
    for (auto& group : groups) {
      const auto actual_parameter_id = ParameterIdRaw(
          model, group.parameter_index);
      if (actual_parameter_id.empty()
          || actual_parameter_id != group.parameter_id) {
        return reject("parameter_identity_mismatch:" + group.parameter_id);
      }
      const auto index = static_cast<csmUint32>(group.parameter_index);
      group.snapshot = ParameterFrameSnapshot{
          actual_parameter_id,
          model->GetParameterValue(group.parameter_index),
          model->GetParameterMinimumValue(index),
          model->GetParameterMaximumValue(index)};
      if (!std::isfinite(group.snapshot.base_value)
          || !std::isfinite(group.snapshot.minimum_value)
          || !std::isfinite(group.snapshot.maximum_value)
          || group.snapshot.minimum_value > group.snapshot.maximum_value) {
        return reject("runtime_range_or_base_invalid:" + group.parameter_id);
      }
      std::stable_sort(
          group.contributions.begin(),
          group.contributions.end(),
          [](const auto* left, const auto* right) {
            if (left->priority != right->priority) {
              return left->priority < right->priority;
            }
            return left->source < right->source;
          });
    }

    std::vector<std::pair<csmInt32, float>> resolved_values;
    resolved_values.reserve(groups.size());
    for (auto& group : groups) {
      const auto base_value = group.snapshot.base_value;
      auto mixed_target = base_value;
      auto direct_only_target = base_value;
      bool has_lip_sync = false;
      ParameterPresentationState* presentation_state = nullptr;
      bool presentation_is_direct_plan = false;
      double presentation_elapsed_ms = 0.0;
      for (const auto* contribution : group.contributions) {
        mixed_target = mixed_target * (1.0f - contribution->weight)
            + contribution->value * contribution->weight;
        if (contribution->owner == ParameterContributionOwner::LipSync) {
          has_lip_sync = true;
        } else {
          direct_only_target = direct_only_target * (1.0f - contribution->weight)
              + contribution->value * contribution->weight;
          if (contribution->presentation) {
            presentation_state = contribution->presentation;
            presentation_is_direct_plan = contribution->presentation_is_direct_plan;
            presentation_elapsed_ms = contribution->elapsed_ms;
          }
        }
      }

      auto final_value = has_lip_sync ? mixed_target : direct_only_target;
      if (presentation_state) {
        auto& presentation = *presentation_state;
        const auto target = ResolveEnvelopeTarget(
            presentation,
            direct_only_target,
            presentation_elapsed_ms,
            presentation_is_direct_plan && _active_parameter_plan
                ? &*_active_parameter_plan : nullptr);
        const auto target_offset = target - base_value;
        if (presentation.last_elapsed_ms < 0.0) {
          presentation.last_elapsed_ms = presentation_elapsed_ms;
        } else if (presentation_elapsed_ms > presentation.last_elapsed_ms) {
          const auto delta_seconds = static_cast<float>(
              (presentation_elapsed_ms - presentation.last_elapsed_ms) / 1000.0);
          const auto next_state = presentation.response_kind == "spring"
              ? AdvanceSpring(
                  presentation.driven_offset,
                  target_offset,
                  presentation.velocity,
                  delta_seconds,
                  presentation.max_velocity,
                  presentation.max_acceleration,
                  presentation.response_frequency_hz,
                  presentation.response_damping_ratio)
              : AdvanceBounded(
                  presentation.driven_offset,
                  target_offset,
                  presentation.velocity,
                  delta_seconds,
                  presentation.max_velocity,
                  presentation.max_acceleration);
          presentation.velocity = next_state.velocity;
          presentation.driven_offset = next_state.value;
          presentation.last_elapsed_ms = presentation_elapsed_ms;
        }
        if (!has_lip_sync) {
          final_value = base_value + presentation.driven_offset;
        }
        const bool settled = std::abs(presentation.driven_offset - target_offset) <= 0.001f
            && std::abs(presentation.velocity) <= 0.001f;
        if (presentation_is_direct_plan) {
          direct_presentation_settled &= settled;
        }
      }

      if (!std::isfinite(final_value)) {
        return reject("resolved_value_invalid:" + group.parameter_id);
      }
      resolved_values.emplace_back(
          group.parameter_index,
          std::clamp(
              final_value,
              group.snapshot.minimum_value,
              group.snapshot.maximum_value));
    }

    for (const auto& [parameter_index, value] : resolved_values) {
      model->SetParameterValue(parameter_index, value);
      const auto readback = model->GetParameterValue(parameter_index);
      if (!std::isfinite(readback) || std::abs(readback - value) > 0.001f) {
        return reject("write_mismatch:" + ParameterIdRaw(model, parameter_index));
      }
    }
    return true;
  }

  static std::string SelectedModelName(
      const ag99::runtime::Json& model_sync_payload) {
    const auto model_info = model_sync_payload.find("model_info");
    return model_info != model_sync_payload.end() && model_info->is_object()
        ? ReadString(*model_info, "selected_model")
        : std::string{};
  }

  static const ag99::runtime::Json* SelectedModelProfile(
      const ag99::runtime::Json& model_sync_payload) {
    const auto model_info = model_sync_payload.find("model_info");
    if (model_info == model_sync_payload.end() || !model_info->is_object()) {
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

  const ag99::runtime::Json* SelectedModelProfile() const {
    return SelectedModelProfile(_model_sync_payload);
  }

  static std::optional<std::array<double, 2>> ReadNumberPair(
      const ag99::runtime::Json& object,
      const char* key) {
    const auto it = object.find(key);
    if (it == object.end() || !it->is_array() || it->size() != 2
        || !(*it)[0].is_number() || !(*it)[1].is_number()) {
      return std::nullopt;
    }
    const std::array<double, 2> result{
        (*it)[0].get<double>(), (*it)[1].get<double>()};
    if (!std::isfinite(result[0]) || !std::isfinite(result[1])) {
      return std::nullopt;
    }
    return result;
  }

  static std::string LowerAscii(std::string value) {
    std::transform(value.begin(), value.end(), value.begin(), [](unsigned char ch) {
      return static_cast<char>(std::tolower(ch));
    });
    return value;
  }

  static std::string TrimAscii(std::string value) {
    const auto not_space = [](unsigned char ch) {
      return std::isspace(ch) == 0;
    };
    const auto first = std::find_if(value.begin(), value.end(), not_space);
    const auto last = std::find_if(value.rbegin(), value.rend(), not_space).base();
    return first < last ? std::string(first, last) : std::string{};
  }

  static int InteractionAxisPriority(
      const ag99::runtime::Json& axis,
      bool gaze) {
    const auto id = LowerAscii(ReadString(axis, "id"));
    const auto text = id + " " + LowerAscii(ReadString(axis, "label")) + " "
        + LowerAscii(ReadString(axis, "description")) + " "
        + LowerAscii(ReadString(axis, "usage_notes"));
    if (gaze) {
      if (id == "gaze_x") return 0;
      if (id == "head_yaw") return 1;
      for (const auto* token : {"gaze", "视线", "眼神", "扭头", "yaw"}) {
        if (text.find(token) != std::string::npos) return 2;
      }
      return -1;
    }
    if (id == "gaze_x" || id == "head_yaw") return 0;
    if (id == "head_roll") return 1;
    if (id == "body_yaw" || id == "body_roll") return 2;
    for (const auto* token : {
             "gaze", "yaw", "roll", "左右", "扭头", "摇摆"}) {
      if (text.find(token) != std::string::npos) return 3;
    }
    return -1;
  }

  const ag99::runtime::Json* SelectInteractionAxis(bool gaze) const {
    const auto* profile = SelectedModelProfile();
    if (!profile) {
      return nullptr;
    }
    const auto axes = profile->find("axes");
    if (axes == profile->end() || !axes->is_array()) {
      return nullptr;
    }
    const ag99::runtime::Json* selected = nullptr;
    int selected_priority = std::numeric_limits<int>::max();
    for (const auto& axis : *axes) {
      if (!axis.is_object()) {
        continue;
      }
      const auto role = ReadString(axis, "control_role");
      const auto anchors = axis.find("level_anchors");
      const auto bindings = axis.find("parameter_bindings");
      if ((role != "primary" && role != "hint")
          || anchors == axis.end() || !anchors->is_object()
          || !anchors->contains("-1") || !anchors->contains("1")
          || !anchors->at("-1").is_number()
          || !anchors->at("1").is_number()
          || bindings == axis.end() || !bindings->is_array()
          || bindings->empty()) {
        continue;
      }
      const int priority = InteractionAxisPriority(axis, gaze);
      if (priority >= 0 && priority < selected_priority) {
        selected = &axis;
        selected_priority = priority;
      }
    }
    return selected;
  }

  std::optional<std::vector<InteractionBinding>> CreateInteractionBindings(
      const ag99::runtime::Json& axis,
      double negative_axis_value,
      double positive_axis_value) const {
    auto* model = _model ? _model->GetModel() : nullptr;
    if (!model) {
      return std::nullopt;
    }
    const auto axis_id = ReadString(axis, "id");
    const auto neutral = axis.find("neutral");
    const auto dynamics = axis.find("dynamics");
    const auto bindings = axis.find("parameter_bindings");
    if (axis_id.empty() || neutral == axis.end() || !neutral->is_number()
        || !std::isfinite(neutral->get<double>())
        || dynamics == axis.end() || !dynamics->is_object()
        || bindings == axis.end() || !bindings->is_array()
        || bindings->empty()) {
      return std::nullopt;
    }
    const auto neutral_value = neutral->get<double>();
    const auto axis_max_velocity = dynamics->find("max_velocity");
    const auto axis_max_acceleration = dynamics->find("max_acceleration");
    if (axis_max_velocity == dynamics->end() || !axis_max_velocity->is_number()
        || axis_max_acceleration == dynamics->end()
        || !axis_max_acceleration->is_number()) {
      return std::nullopt;
    }

    const auto semantic_group = TrimAscii(
        LowerAscii(ReadString(axis, "semantic_group")));
    float response_frequency_hz = 0.0f;
    float response_damping_ratio = 0.0f;
    bool use_spring = true;
    if (semantic_group == "head") {
      response_frequency_hz = 2.9f;
      response_damping_ratio = 0.72f;
    } else if (semantic_group == "body") {
      response_frequency_hz = 1.05f;
      response_damping_ratio = 0.84f;
    } else if (semantic_group == "torso") {
      response_frequency_hz = 1.0f;
      response_damping_ratio = 0.86f;
    } else if (semantic_group == "shoulder") {
      response_frequency_hz = 1.08f;
      response_damping_ratio = 0.84f;
    } else if (semantic_group == "gaze") {
      response_frequency_hz = 4.2f;
      response_damping_ratio = 0.74f;
    } else if (semantic_group == "eye") {
      response_frequency_hz = 4.4f;
      response_damping_ratio = 0.86f;
    } else if (semantic_group == "brow") {
      response_frequency_hz = 3.9f;
      response_damping_ratio = 0.78f;
    } else if (semantic_group == "face") {
      response_frequency_hz = 3.6f;
      response_damping_ratio = 0.78f;
    } else {
      use_spring = false;
    }

    const auto map_binding_value = [&](const ag99::runtime::Json& binding,
                                       double value,
                                       double& target,
                                       double& neutral_target) {
      const auto input_range = ReadNumberPair(binding, "input_range");
      const auto output_range = ReadNumberPair(binding, "output_range");
      const auto invert = binding.find("invert");
      if (!input_range || !output_range
          || (*input_range)[0] == (*input_range)[1]
          || value < (*input_range)[0] || value > (*input_range)[1]
          || !std::isfinite(neutral_value)
          || (invert != binding.end() && !invert->is_boolean())) {
        return false;
      }
      const auto ratio = (value - (*input_range)[0])
          / ((*input_range)[1] - (*input_range)[0]);
      const bool inverted = invert != binding.end() && invert->get<bool>();
      const auto effective_ratio = inverted ? 1.0 - ratio : ratio;
      target = (*output_range)[0]
          + ((*output_range)[1] - (*output_range)[0]) * effective_ratio;
      const auto neutral_ratio = (neutral_value - (*input_range)[0])
          / ((*input_range)[1] - (*input_range)[0]);
      const auto effective_neutral_ratio = inverted
          ? 1.0 - neutral_ratio : neutral_ratio;
      neutral_target = (*output_range)[0]
          + ((*output_range)[1] - (*output_range)[0])
              * effective_neutral_ratio;
      return std::isfinite(target) && std::isfinite(neutral_target);
    };

    std::vector<InteractionBinding> result;
    result.reserve(bindings->size());
    std::unordered_set<csmInt32> seen_parameter_indices;
    for (const auto& binding : *bindings) {
      if (!binding.is_object()) {
        return std::nullopt;
      }
      const auto parameter_id = TrimAscii(ReadString(binding, "parameter_id"));
      const auto weight_it = binding.find("default_weight");
      if (parameter_id.empty() || weight_it == binding.end()
          || !weight_it->is_number()) {
        return std::nullopt;
      }
      const auto weight = weight_it->get<double>();
      if (!std::isfinite(weight) || weight < 0.0 || weight > 1.0) {
        return std::nullopt;
      }
      double mapped_neutral = 0.0;
      double neutral_again = 0.0;
      double mapped_negative = 0.0;
      double negative_neutral = 0.0;
      double mapped_positive = 0.0;
      double positive_neutral = 0.0;
      if (!map_binding_value(binding, neutral_value, mapped_neutral, neutral_again)
          || !map_binding_value(
              binding, negative_axis_value, mapped_negative, negative_neutral)
          || !map_binding_value(
              binding, positive_axis_value, mapped_positive, positive_neutral)
          || std::abs(mapped_neutral - neutral_again) > 1e-6
          || std::abs(mapped_neutral - negative_neutral) > 1e-6
          || std::abs(mapped_neutral - positive_neutral) > 1e-6) {
        return std::nullopt;
      }
      const auto parameter_id_handle =
          CubismFramework::GetIdManager()->GetId(parameter_id.c_str());
      const auto parameter_index = model->GetParameterIndex(parameter_id_handle);
      if (parameter_index < 0
          || !seen_parameter_indices.insert(parameter_index).second) {
        return std::nullopt;
      }
      const auto index = static_cast<csmUint32>(parameter_index);
      const auto minimum = model->GetParameterMinimumValue(index);
      const auto maximum = model->GetParameterMaximumValue(index);
      const auto input_range = ReadNumberPair(binding, "input_range");
      const auto output_range = ReadNumberPair(binding, "output_range");
      if (!input_range || !output_range
          || !std::isfinite(minimum) || !std::isfinite(maximum)
          || minimum > maximum
          || mapped_neutral < minimum || mapped_neutral > maximum
          || mapped_negative < minimum || mapped_negative > maximum
          || mapped_positive < minimum || mapped_positive > maximum) {
        return std::nullopt;
      }
      const double input_span = std::abs((*input_range)[1] - (*input_range)[0]);
      if (input_span <= 0.0) {
        return std::nullopt;
      }
      const double output_per_input = std::abs(
          (*output_range)[1] - (*output_range)[0]) / input_span;
      const double max_velocity = axis_max_velocity->get<double>() * output_per_input;
      const double max_acceleration =
          axis_max_acceleration->get<double>() * output_per_input;
      if (!std::isfinite(max_velocity) || !std::isfinite(max_acceleration)
          || max_velocity <= 0.0 || max_acceleration <= 0.0) {
        return std::nullopt;
      }

      ParameterPresentationState presentation;
      presentation.initial_value = model->GetParameterValue(parameter_index);
      presentation.neutral_value = static_cast<float>(mapped_neutral);
      presentation.max_velocity = static_cast<float>(max_velocity);
      presentation.max_acceleration = static_cast<float>(max_acceleration);
      presentation.response_kind = use_spring ? "spring" : "bounded";
      presentation.response_frequency_hz = response_frequency_hz;
      presentation.response_damping_ratio = response_damping_ratio;
      result.push_back(InteractionBinding{
          axis_id,
          parameter_id,
          parameter_index,
          static_cast<float>(mapped_neutral),
          static_cast<float>(mapped_negative),
          static_cast<float>(mapped_positive),
          static_cast<float>(weight),
          std::move(presentation)});
    }
    return result.empty()
        ? std::nullopt
        : std::optional<std::vector<InteractionBinding>>(std::move(result));
  }

  std::optional<InteractionSwayState> CreateInteractionSway(
      const std::string& turn_id) const {
    const auto* axis = SelectInteractionAxis(false);
    if (!axis) {
      return std::nullopt;
    }
    const auto anchors = axis->find("level_anchors");
    auto bindings = CreateInteractionBindings(
        *axis,
        anchors->at("-1").get<double>(),
        anchors->at("1").get<double>());
    if (!bindings) {
      return std::nullopt;
    }
    return InteractionSwayState{
        turn_id,
        4000.0,
        500.0,
        650.0,
        0.0,
        std::nullopt,
        std::move(*bindings)};
  }

  std::optional<InteractionGazeState> CreateInteractionGaze(
      double target_ratio) const {
    const auto* axis = SelectInteractionAxis(true);
    if (!axis) {
      return std::nullopt;
    }
    const auto anchors = axis->find("level_anchors");
    auto bindings = CreateInteractionBindings(
        *axis,
        anchors->at("-1").get<double>(),
        anchors->at("1").get<double>());
    if (!bindings) {
      return std::nullopt;
    }
    return InteractionGazeState{
        std::clamp(target_ratio, -1.0, 1.0),
        0.0,
        std::move(*bindings)};
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

    struct AxisDefinition {
      double neutral = 0.0;
      double value_min = 0.0;
      double value_max = 100.0;
      double strong_min = 0.0;
      double strong_max = 100.0;
      std::string group;
    };

    struct AxisValue {
      double value = 0.0;
      double neutral = 0.0;
      std::string group;
    };

    using AxisMap = std::unordered_map<std::string, AxisValue>;
    const auto read_range = [](const ag99::runtime::Json& axis,
                               const char* key,
                               double fallback_min,
                               double fallback_max) {
      std::array<double, 2> result{fallback_min, fallback_max};
      const auto range = axis.find(key);
      if (range != axis.end() && range->is_array() && range->size() == 2
          && (*range)[0].is_number() && (*range)[1].is_number()) {
        result[0] = (*range)[0].get<double>();
        result[1] = (*range)[1].get<double>();
      }
      return result;
    };
    std::unordered_map<std::string, AxisDefinition> axis_definitions;
    for (const auto& axis : *axes) {
      if (!axis.is_object()) {
        continue;
      }
      const auto id = ReadString(axis, "id");
      if (id.empty()) {
        continue;
      }
      const auto value_range = read_range(axis, "value_range", 0.0, 100.0);
      const auto strong_range = read_range(
          axis, "strong_range", value_range[0], value_range[1]);
      axis_definitions.emplace(
          id,
          AxisDefinition{
              ReadNumber(axis, "neutral", 50.0),
              value_range[0],
              value_range[1],
              strong_range[0],
              strong_range[1],
              ReadString(axis, "semantic_group")});
    }

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
        const auto definition_it = axis_definitions.find(id);
        if (definition_it == axis_definitions.end()) {
          continue;
        }
        const auto& definition = definition_it->second;
        const double neutral = definition.neutral;
        double value = neutral;
        const auto anchors = axis.find("level_anchors");
        if (anchors != axis.end() && anchors->is_object()) {
          const auto key = std::to_string(level_it->get<int>());
          const auto anchor = anchors->find(key);
          if (anchor != anchors->end() && anchor->is_number()) {
            value = anchor->get<double>();
          }
        }
        value = Clamp(value, definition.value_min, definition.value_max);
        resolved.emplace(id, AxisValue{value, neutral, definition.group});
        explicit_axes.insert(id);
      }

      const auto relation_graph = profile->find("relation_graph");
      if (relation_graph == profile->end() || !relation_graph->is_object()) {
        return resolved;
      }
      const auto edges = relation_graph->find("edges");
      if (edges == relation_graph->end() || !edges->is_array()) {
        return resolved;
      }

      const auto maps_equal = [](const AxisMap& left, const AxisMap& right) {
        if (left.size() != right.size()) {
          return false;
        }
        for (const auto& [axis_id, value] : left) {
          const auto other = right.find(axis_id);
          if (other == right.end()
              || std::abs(value.value - other->second.value) > 1e-6) {
            return false;
          }
        }
        return true;
      };

      AxisMap previous_values = resolved;
      const int max_passes = std::max(
          2,
          static_cast<int>(edges->size()) + 2);
      for (int pass = 0; pass < max_passes; ++pass) {
        AxisMap current_values = resolved;
        for (const auto& edge : *edges) {
          if (!edge.is_object()) {
            continue;
          }
          const auto source_id = ReadString(edge, "source_axis_id");
          const auto target_id = ReadString(edge, "target_axis_id");
          const auto source = previous_values.find(source_id);
          const auto target_definition = axis_definitions.find(target_id);
          if (source == previous_values.end()
              || target_definition == axis_definitions.end()) {
            continue;
          }

          const auto& target_axis = target_definition->second;
          const double source_delta =
              source->second.value - source->second.neutral;
          const double scale = ReadNumber(edge, "scale", 0.0);
          const double deadzone = std::max(
              0.0,
              ReadNumber(edge, "deadzone", 0.0));
          const double max_delta = std::max(
              0.0,
              ReadNumber(edge, "max_delta", 0.0));
          const double direction =
              ReadString(edge, "mode") == "opposite_direction" ? -1.0 : 1.0;
          const auto derive_target = [&]() {
            const double raw_candidate =
                target_axis.neutral + source_delta * scale * direction;
            const double max_delta_value = target_axis.neutral + Clamp(
                raw_candidate - target_axis.neutral,
                -max_delta,
                max_delta);
            const double constrained_value = Clamp(
                max_delta_value,
                target_axis.value_min,
                target_axis.value_max);
            return AxisValue{
                constrained_value,
                target_axis.neutral,
                target_axis.group};
          };

          if (ReadString(edge, "kind") == "derive") {
            if (explicit_axes.contains(target_id)
                || std::abs(source_delta) <= deadzone) {
              continue;
            }
            current_values[target_id] = derive_target();
            continue;
          }

          if (ReadString(edge, "kind") != "bounded_ratio") {
            continue;
          }
          const auto target = current_values.find(target_id);
          if (target == current_values.end()) {
            if (std::abs(source_delta) <= deadzone) {
              continue;
            }
            current_values[target_id] = derive_target();
            continue;
          }

          const double target_delta =
              target->second.value - target_axis.neutral;
          const double strong_half_span = std::max(
              std::abs(target_axis.strong_max - target_axis.neutral),
              std::abs(target_axis.neutral - target_axis.strong_min));
          const double hard_cap = std::max(
              max_delta,
              strong_half_span + std::min(deadzone, 6.0));
          const bool direction_mismatch =
              source_delta != 0.0
              && target_delta != 0.0
              && source_delta * target_delta * direction < 0.0;
          const double limit = direction_mismatch
              ? std::min(
                  hard_cap * 0.5,
                  std::max(
                      deadzone * 0.6,
                      std::abs(source_delta) * (scale * 0.35)
                          + deadzone * 0.5))
              : std::min(
                  hard_cap,
                  std::max(
                      deadzone,
                      std::abs(source_delta) * scale + deadzone));
          target->second.value = Clamp(
              target_axis.neutral + Clamp(target_delta, -limit, limit),
              target_axis.value_min,
              target_axis.value_max);
        }

        if (maps_equal(previous_values, current_values)) {
          return current_values;
        }
        previous_values = std::move(current_values);
      }
      return previous_values;
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
              keyframes.front().at_ms,
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
      std::optional<MotionPlan> plan;
      try {
        plan = CompileMotionPlan(*_pending_motion_intent);
      } catch (const std::exception& error) {
        std::cerr << "[motion] compile threw " << typeid(error).name()
                  << ": " << error.what() << '\n';
      } catch (...) {
        std::cerr << "[motion] compile threw an unknown exception\n";
      }
      _pending_motion_intent.reset();
      const auto turn_id = _pending_motion_intent_turn_id.value_or("");
      _pending_motion_intent_turn_id.reset();
      if (plan) {
        _active_motion = *plan;
        ReleaseThinkingSwayLocked(turn_id);
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
        double value = track.neutral_value;
        const double track_start_ms = track.start_at_ms;
        if (elapsed_ms >= track_start_ms) {
          const double track_blend_out_start_ms = std::max(
              track_start_ms,
              static_cast<double>(_active_motion->duration_ms
                  - _active_motion->blend_out_ms));
          const double next_keyframe_ms = track.keyframes.size() > 1
              ? static_cast<double>(track.keyframes[1].at_ms)
              : static_cast<double>(_active_motion->duration_ms);
          const double blend_in_end_ms = std::min({
              track_start_ms
                  + static_cast<double>(_active_motion->blend_in_ms),
              next_keyframe_ms,
              track_blend_out_start_ms,
              static_cast<double>(_active_motion->duration_ms)});
          if (elapsed_ms < blend_in_end_ms) {
            const double t = Clamp(
                (elapsed_ms - track_start_ms)
                    / std::max(1.0, blend_in_end_ms - track_start_ms),
                0.0, 1.0);
            const double smooth = t * t * (3.0 - 2.0 * t);
            value = track.neutral_value
                + (track.keyframes.front().target_value
                    - track.neutral_value) * smooth;
          } else {
            value = track.keyframes.back().target_value;
            for (std::size_t index = 1;
                 index < track.keyframes.size();
                 ++index) {
              const auto& previous = track.keyframes[index - 1];
              const auto& next = track.keyframes[index];
              if (elapsed_ms < next.at_ms) {
                const double previous_at_ms = index == 1
                    ? std::max(
                          static_cast<double>(previous.at_ms),
                          blend_in_end_ms)
                    : static_cast<double>(previous.at_ms);
                const double window = std::max(
                    1.0,
                    static_cast<double>(next.at_ms) - previous_at_ms);
                const double t = Clamp(
                    (elapsed_ms - previous_at_ms) / window, 0.0, 1.0);
                const double smooth = t * t * (3.0 - 2.0 * t);
                value = previous.target_value
                    + (next.target_value - previous.target_value) * smooth;
                break;
              }
            }
            if (elapsed_ms >= track_blend_out_start_ms) {
              const double t = Clamp(
                  (elapsed_ms - track_blend_out_start_ms)
                      / std::max(
                          1.0,
                          static_cast<double>(_active_motion->duration_ms)
                              - track_blend_out_start_ms),
                  0.0, 1.0);
              const double smooth = t * t * (3.0 - 2.0 * t);
              value += (track.neutral_value - value) * smooth;
            }
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
  ag99::live2d::D3D11Renderer _renderer;
  UINT _width = 0;
  UINT _height = 0;
  double _last_update_seconds = 0.0;
  ag99::runtime::Json _model_sync_payload = ag99::runtime::Json::object();
  std::optional<MotionPlan> _active_motion;
  std::optional<ag99::runtime::Json> _pending_motion_intent;
  std::optional<ParameterPlan> _active_parameter_plan;
  std::optional<ag99::runtime::Json> _pending_parameter_plan;
  std::optional<std::string> _pending_parameter_plan_turn_id;
  std::optional<std::string> _pending_motion_intent_turn_id;
  std::optional<std::string> _pending_thinking_turn_id;
  std::optional<InteractionSwayState> _interaction_sway;
  std::optional<InteractionGazeState> _interaction_gaze;
  double _next_cursor_poll_ms = 0.0;
  double _gaze_candidate_x = 0.0;
  double _gaze_candidate_y = 0.0;
  double _gaze_candidate_since_ms = 0.0;
  bool _gaze_candidate_valid = false;
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
        RECT client_rect{};
        GetClientRect(window, &client_rect);
        const auto client_width = std::max<LONG>(1, client_rect.right);
        const auto client_height = std::max<LONG>(1, client_rect.bottom);
        const auto client_x = std::clamp<LONG>(
            GET_X_LPARAM(lparam), 0, client_width);
        const auto client_y = std::clamp<LONG>(
            GET_Y_LPARAM(lparam), 0, client_height);
        const auto drag_x = static_cast<float>(
            (static_cast<double>(client_x) / client_width) * 2.0 - 1.0);
        const auto drag_y = static_cast<float>(
            1.0 - (static_cast<double>(client_y) / client_height) * 2.0);
        g_drag_x.store(std::clamp(drag_x, -1.0f, 1.0f));
        g_drag_y.store(std::clamp(drag_y, -1.0f, 1.0f));
        POINT cursor{};
        GetCursorPos(&cursor);
        SetWindowPos(
            window, HWND_TOPMOST,
            g_drag_origin.x + cursor.x - g_drag_cursor.x,
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
      WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_NOREDIRECTIONBITMAP,
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
  SetWindowPos(window, HWND_TOPMOST, x, y, static_cast<int>(width),
               static_cast<int>(height), SWP_NOACTIVATE);
  return window;
}

bool StartCubism(ID3D11Device* device) {
  CubismFramework::Option option{};
  option.LogFunction = LogMessage;
  option.LoadFileFunction = LoadFile;
  option.ReleaseBytesFunction = ReleaseFile;
  option.LoggingLevel = CubismFramework::Option::LogLevel_Info;
  if (!CubismFramework::StartUp(&g_allocator, &option)) {
    return false;
  }

  CubismFramework::Initialize();
  ag99::live2d::D3D11Renderer::ConfigureDevice(device);
  return true;
}

void StopCubism() {
  // The D3D11 device-info map owns resources through Cubism's allocator.
  // Release it before Dispose/CleanUp clears that allocator.
  ag99::live2d::D3D11Renderer::ReleaseDeviceResources();
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
  if (!window) {
    return 1;
  }
  ag99::live2d::D3D11CompositionSurface surface;
  if (FAILED(surface.Initialize(window, width, height))) {
    DestroyWindow(window);
    UnregisterClassW(kWindowClassName, instance);
    return 1;
  }
  AddTrayIcon(window);

  if (!StartCubism(surface.Device())) {
    RemoveTrayIcon();
    surface.Shutdown();
    DestroyWindow(window);
    UnregisterClassW(kWindowClassName, instance);
    return 1;
  }

  int result_code = 0;
  {
    NativeModel model;
    RuntimeBridge runtime(
        [&model](ag99::runtime::ModelSync sync) {
          model.SetModelSync(sync.payload);
        },
        [&model](
            const ag99::runtime::Json& motion_intent,
            const std::string& turn_id) {
          model.QueueMotionPayload(motion_intent, turn_id);
        },
        [&model](const std::string& turn_id) {
          model.StartThinkingSway(turn_id);
        },
        [&model](const std::string& turn_id) {
          model.ReleaseThinkingSway(turn_id);
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
    if (!model_json.empty() && !model.Load(
            model_json, width, height, surface.Device(), surface.Context())) {
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
      int consecutive_frame_failures = 0;
      constexpr int kMaxConsecutiveFrameFailures = 30;
      // A frame may fail after BeginFrame already bound the render target, so
      // the boundary must stay resumable: BeginFrame is idempotent and no
      // per-frame GPU state survives the throw.
      const auto record_frame_failure = [&](const std::string& detail) {
        std::cerr << detail << '\n';
        if (++consecutive_frame_failures < kMaxConsecutiveFrameFailures) {
          return;
        }
        std::cerr << "[frame] too many consecutive failures; stopping\n";
        result_code = 1;
        running = false;
      };
      while (running) {
        while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) {
          if (message.message == WM_QUIT) {
            running = false;
          }
          TranslateMessage(&message);
          DispatchMessageW(&message);
        }

        try {
          model.UpdateCursorGaze(window);

          const HRESULT begin_result = surface.BeginFrame();
          if (FAILED(begin_result)) {
            std::cerr << "D3D11 BeginFrame failed: 0x" << std::hex
                      << static_cast<unsigned long>(begin_result) << std::dec
                      << '\n';
            result_code = 1;
            running = false;
            continue;
          }
          model.UpdateAndDraw();
          const HRESULT present_result = surface.Present(1, 0);
          if (FAILED(present_result)) {
            std::cerr << "D3D11 Present failed: 0x" << std::hex
                      << static_cast<unsigned long>(present_result) << std::dec
                      << '\n';
            result_code = 1;
            running = false;
            continue;
          }
          consecutive_frame_failures = 0;
        } catch (const std::exception& error) {
          record_frame_failure(
              std::string("[frame] threw ") + typeid(error).name() + ": "
              + error.what());
        } catch (...) {
          record_frame_failure("[frame] threw an unknown exception");
        }
        Sleep(1);
      }
    }
    runtime.Close();
    g_send_text = {};
    g_toggle_microphone = {};
    g_microphone_running = {};
  }

  StopCurrentAudio();
  StopCubism();
  surface.Shutdown();
  DestroyWindow(window);
  UnregisterClassW(kWindowClassName, instance);
  return result_code;
}

std::filesystem::path FindDefaultModelPath() {
  std::wstring executable_path(32768, L'\0');
  const DWORD path_length = GetModuleFileNameW(
      nullptr,
      executable_path.data(),
      static_cast<DWORD>(executable_path.size()));
  if (path_length == 0
      || static_cast<std::size_t>(path_length) >= executable_path.size()) {
    return {};
  }
  executable_path.resize(path_length);

  auto directory = std::filesystem::path(executable_path).parent_path();
  const std::filesystem::path relative_model =
      L"astrbot_plugin_ag99live_adapter/live2ds/Mk6_1.0/Mk6.model3.json";
  while (!directory.empty()) {
    std::error_code error;
    const auto candidate = directory / relative_model;
    if (std::filesystem::is_regular_file(candidate, error)) {
      return candidate;
    }
    const auto parent = directory.parent_path();
    if (parent == directory) {
      break;
    }
    directory = parent;
  }
  return {};
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
  if (model_json.empty()) {
    model_json = FindDefaultModelPath();
    if (model_json.empty()) {
      MessageBoxW(
          nullptr,
          L"Could not find the default Mk6 demo model. Run this executable "
          L"from the repository build or pass a model3.json path.",
          kWindowTitle,
          MB_OK | MB_ICONERROR);
      if (SUCCEEDED(com_result)) {
        CoUninitialize();
      }
      return 1;
    }
  }
  const int result = Run(instance, model_json, startup_text);
  if (SUCCEEDED(com_result)) {
    CoUninitialize();
  }
  return result;
}
