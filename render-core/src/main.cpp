#include <windows.h>
#include <commctrl.h>
#include <imm.h>
#include <mmsystem.h>
#include <shellapi.h>
#include <winhttp.h>
#include <windowsx.h>

#ifndef EM_SETCUEBANNER
#define EM_SETCUEBANNER (WM_USER + 1)
#endif

#include <algorithm>
#include <array>
#include <atomic>
#include <charconv>
#include <cctype>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <condition_variable>
#include <cwctype>
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
#include "ag99/audio/audio_source.hpp"
#include "ag99/audio/wav_audio.hpp"
#include "ag99/live2d/d3d11_composition_surface.hpp"
#include "ag99/live2d/d3d11_renderer.hpp"
#include "ag99/live2d/log.hpp"
#include "ag99/platform/tray_controller.hpp"
#include "ag99/platform/input_text.hpp"
#include "ag99/platform/input_overlay_state.hpp"
#include "ag99/platform/input_overlay_paint.hpp"
#include "ag99/platform/input_overlay_button_paint.hpp"
#include "ag99/platform/input_overlay_controls.hpp"
#include "ag99/platform/input_overlay_view.hpp"
#include "ag99/platform/input_overlay_resources.hpp"
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
constexpr UINT kTrayInputWindow = 1006;
constexpr UINT kTrayClickThrough = 1007;
constexpr UINT kTrayOpenLog = 1008;
constexpr UINT kInputConnectionChanged = WM_APP + 2;
constexpr UINT kInputRuntimeStateChanged = WM_APP + 3;

ag99::platform::TrayController g_tray_controller;
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
std::function<bool(std::string)> g_send_text;
std::function<void()> g_toggle_microphone;
std::function<bool()> g_microphone_running;
std::function<bool()> g_reconnect_adapter;
std::function<bool()> g_interrupt_turn;
std::function<bool()> g_approve_latest_segment;
std::atomic<bool> g_runtime_connected{false};
std::mutex g_input_window_mutex;
HWND g_input_window = nullptr;
ag99::platform::InputOverlayState g_input_state;
bool g_click_through = false;

void NotifyInputConnectionChanged();
void NotifyInputRuntimeStateChanged();

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

std::string TrimAsciiText(std::string value) {
  const auto whitespace = [](unsigned char character) {
    return character == ' ' || character == '\t' || character == '\n'
        || character == '\r' || character == '\v' || character == '\f';
  };
  auto first = value.begin();
  while (first != value.end() && whitespace(static_cast<unsigned char>(*first))) {
    ++first;
  }
  auto last = value.end();
  while (last != first && whitespace(static_cast<unsigned char>(*(last - 1)))) {
    --last;
  }
  return std::string(first, last);
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

std::optional<std::filesystem::path> PathFromUtf8(std::string_view value) {
  const auto wide = WidenUtf8(value);
  if (wide.empty()) {
    return std::nullopt;
  }
  return std::filesystem::path(wide);
}

std::string PathToUtf8(const std::filesystem::path& value) {
  const auto encoded = value.u8string();
  return std::string(
      reinterpret_cast<const char*>(encoded.data()), encoded.size());
}

void StopCurrentAudio(
    std::optional<std::uint64_t> expected_serial = std::nullopt) {
  std::scoped_lock lock(g_audio_file_mutex);
  if (expected_serial && g_audio_serial.load() != *expected_serial) {
    return;
  }
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
  double started_at_seconds = 0.0;
};

// The render host keeps this clock metadata outside the wire protocol. It is
// the shared time origin for one output segment's audio and motion paths.
struct NativeSegmentClock {
  std::string turn_id;
  std::string message_id;
  std::int64_t sequence = 0;
  double started_at_seconds = 0.0;
  double duration_seconds = 0.0;
  std::uint64_t audio_serial = 0;
  std::uint64_t generation = 0;
};

struct NativeSegmentTerminal {
  NativeSegmentClock clock;
  bool success = false;
  std::string reason;
};

std::optional<AudioPlayback> PlayAudioUrl(
    const std::string& url, std::string& failure_reason) {
  std::vector<std::uint8_t> bytes;
  if (!ag99::audio::DownloadAudioWav(url, bytes)) {
    failure_reason = "audio_download_failed";
    std::cerr << "Failed to download audio: " << url << '\n';
    return std::nullopt;
  }
  const auto duration = ag99::audio::ReadWavDuration(bytes);
  if (!duration) {
    failure_reason = "audio_wav_invalid";
    std::cerr << "Downloaded WAV has no valid playback duration: " << url
              << '\n';
    return std::nullopt;
  }
  const auto path = ag99::audio::WriteTempAudio(bytes);
  if (!path) {
    failure_reason = "audio_cache_write_failed";
    return std::nullopt;
  }
  const auto rms = ag99::audio::ReadWavRms(bytes);
  std::uint64_t serial = 0;
  double started_at_seconds = 0.0;
  BOOL playback_started = FALSE;
  {
    std::scoped_lock lock(g_audio_file_mutex);
    serial = g_audio_serial.fetch_add(1) + 1;
    PlaySoundW(nullptr, nullptr, 0);
    if (!g_audio_file.empty()) {
      DeleteFileW(g_audio_file.c_str());
    }
    g_audio_file = *path;
    playback_started = PlaySoundW(
        g_audio_file.c_str(), nullptr,
        SND_FILENAME | SND_ASYNC | SND_NODEFAULT);
    if (!playback_started) {
      DeleteFileW(g_audio_file.c_str());
      g_audio_file.clear();
    } else {
      started_at_seconds = NowSeconds();
      {
        std::scoped_lock signal_lock(g_audio_signal_mutex);
        g_audio_rms = rms;
      }
      g_audio_start_seconds.store(started_at_seconds);
      g_audio_end_seconds.store(started_at_seconds + *duration);
    }
  }
  if (!playback_started) {
    failure_reason = "audio_playback_failed";
    std::cerr << "PlaySoundW failed to start downloaded WAV: " << url << '\n';
    StopCurrentAudio(serial);
    return std::nullopt;
  }
  failure_reason.clear();
  return AudioPlayback{*duration, serial, started_at_seconds};
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
      const auto relative_path = PathFromUtf8(file_name);
      if (!relative_path) {
        return false;
      }
      std::vector<csmByte> bytes;
      const auto path = model_directory / *relative_path;
      if (!ReadFile(path, bytes)) {
        std::cerr << "[cubism] failed to read " << label
                  << ": " << PathToUtf8(path) << '\n';
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
      const auto relative_path = PathFromUtf8(file_name);
      if (!relative_path) {
        continue;
      }
      std::vector<csmByte> bytes;
      const auto path = model_directory / *relative_path;
      if (!ReadFile(path, bytes)) {
        std::cerr << "[cubism] failed to read expression "
                  << name << ": " << PathToUtf8(path) << '\n';
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
    const auto relative_path = PathFromUtf8(file_name);
    if (!relative_path) {
      return nullptr;
    }
    const auto motion_path = model_directory / *relative_path;
    std::vector<csmByte> motion_bytes;
    if (!ReadFile(motion_path, motion_bytes)) {
      std::cerr << "[cubism] failed to read " << label
                << " motion: " << PathToUtf8(motion_path) << '\n';
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
  std::uint64_t dropped_bytes_ = 0;
  // True between a successful stream start and its matching end, so Stop
  // still emits input.audio_stream_end after the sender already cleared
  // running_.
  bool running_stream_active_ = false;
  bool send_failed_ = false;
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
  struct CallbackLifetime {
    std::mutex mutex;
    RuntimeBridge* owner = nullptr;
  };
  struct AssistantSegment {
    std::string turn_id;
    std::string message_id;
    std::string text;
    bool approved = false;
  };

public:
  RuntimeBridge(
      std::function<void(ag99::runtime::ModelSync)> on_model_sync,
      std::function<void(
          ag99::runtime::OutputSegment,
          std::optional<NativeSegmentClock>)> on_output_segment,
      std::function<void(std::uint64_t)> on_output_segment_reset,
      std::function<void(const std::string&)> on_turn_started,
      std::function<void(const std::string&, bool, const std::string&)>
          on_turn_finished,
      std::function<void(const std::string&)> on_turn_interrupted,
      std::function<ag99::runtime::DesktopSettingsResult(
          const ag99::runtime::DesktopSettingsQuery&)> on_desktop_settings_query)
      : microphone_(websocket_),
        callback_lifetime_(std::make_shared<CallbackLifetime>()),
        on_model_sync_(std::move(on_model_sync)),
        on_output_segment_(std::move(on_output_segment)),
        on_output_segment_reset_(std::move(on_output_segment_reset)),
        on_turn_started_(std::move(on_turn_started)),
        on_turn_finished_(std::move(on_turn_finished)),
        on_turn_interrupted_(std::move(on_turn_interrupted)),
        on_desktop_settings_query_(std::move(on_desktop_settings_query)),
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
        }) {
    callback_lifetime_->owner = this;
    audio_worker_ = std::thread([this] {
      AudioWorkerLoop();
    });
  }

  ~RuntimeBridge() {
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
    const bool connected = websocket_.connect(
        url,
        {
            [weak_lifetime, generation](std::string text) {
              WithCallbackOwner(weak_lifetime, [&](RuntimeBridge& bridge) {
                bridge.IngestText(generation, text);
              });
            },
            [weak_lifetime, generation](std::vector<std::uint8_t> binary) {
              WithCallbackOwner(weak_lifetime, [&](RuntimeBridge& bridge) {
                bridge.IngestBinary(generation, binary);
              });
            },
            [](std::string error) {
              std::cerr << "[runtime] websocket error: " << error << '\n';
            },
            [weak_lifetime, generation] {
              WithCallbackOwner(weak_lifetime, [&](RuntimeBridge& bridge) {
                bridge.HandleTransportClosed(generation);
              });
            },
        });
    g_runtime_connected.store(connected);
    NotifyInputConnectionChanged();
    return connected;
  }

  bool Reconnect() {
    return Connect("ws://127.0.0.1:12396");
  }

  bool SendText(std::string_view text) {
    const auto message = TrimAsciiText(std::string(text));
    if (message.empty() || !g_runtime_connected.load()) {
      return false;
    }
    const auto turn_id = "native-demo-" +
        std::to_string(next_turn_id_.fetch_add(1));
    const auto envelope = ag99::runtime::build_input_text(message, {}, turn_id);
    const bool sent = websocket_.send_text(envelope.dump());
    if (sent) {
      std::scoped_lock lock(playback_mutex_);
      last_input_turn_id_ = turn_id;
      g_input_state.SetFeedbackAvailable(false);
      g_input_state.SetFeedbackApproved(false);
    }
    if (sent) {
      g_input_state.SetStatusText(L"思考中");
      NotifyInputRuntimeStateChanged();
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
      g_input_state.SetStatusText(L"待命");
      NotifyInputRuntimeStateChanged();
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
      g_input_state.SetFeedbackApproved(true);
      NotifyInputRuntimeStateChanged();
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
    g_runtime_connected.store(false);
    NotifyInputConnectionChanged();
    audio_queue_condition_.notify_all();
    transport_lock.unlock();
    {
      std::scoped_lock join_lock(audio_join_mutex_);
      if (audio_worker_.joinable()) {
        audio_worker_.join();
      }
    }
    if (!was_closing) {
      StopCurrentAudio();
    }
  }

private:
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
  };

  enum class PlaybackAckSendResult {
    Sent,
    Canceled,
    Failed,
  };

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
      std::uint64_t generation) {
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
    segment.audio_terminal =
        output.audio.state != ag99::runtime::AudioSlot::State::Present;
    segment.motion_terminal =
        output.motion.state != ag99::runtime::MotionSlot::State::Present;
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
      if (segment == turn->second.segments.end()
          || segment->second.motion_terminal) {
        return;
      }
      segment->second.motion_terminal = true;
      if (!terminal.success) {
        segment->second.motion_failure_reason = ResolveFailureReason(
            terminal.reason,
            "motion_playback_failed:" + terminal.clock.message_id);
      }
      if (terminal.success && latest_assistant_segment_
          && latest_assistant_segment_->message_id == terminal.clock.message_id) {
        g_input_state.SetFeedbackAvailable(true);
        g_input_state.SetStatusText(L"待命");
        NotifyInputRuntimeStateChanged();
      }
    }
    QueuePlaybackAcknowledgement(terminal.clock.turn_id);
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
        std::scoped_lock lock(audio_queue_mutex_);
        for (auto it = audio_queue_.begin(); it != audio_queue_.end();) {
          if (it->turn_id == turn_id) {
            it = audio_queue_.erase(it);
          } else {
            ++it;
          }
        }
        playback_ack_queue_.erase(
            std::remove_if(
                playback_ack_queue_.begin(),
                playback_ack_queue_.end(),
                [&turn_id](const PlaybackAcknowledgementItem& item) {
                  return item.turn_id == turn_id;
                }),
            playback_ack_queue_.end());
        if (current_audio_turn_id_ == turn_id) {
          audio_serial_to_stop = current_audio_serial_;
          current_audio_turn_id_.clear();
          current_audio_message_id_.clear();
          current_audio_generation_ = 0;
          current_audio_serial_ = 0;
        }
      }
      if (audio_serial_to_stop) {
        StopCurrentAudio(*audio_serial_to_stop);
      }
      audio_queue_condition_.notify_one();
    }
  }

  void ClearCurrentAudio(
      const AudioQueueItem& item,
      std::uint64_t audio_serial) {
    std::scoped_lock lock(audio_queue_mutex_);
    if (current_audio_turn_id_ == item.turn_id
        && current_audio_message_id_ == item.message_id
        && current_audio_generation_ == item.generation
        && current_audio_serial_ == audio_serial) {
      current_audio_turn_id_.clear();
      current_audio_message_id_.clear();
      current_audio_generation_ = 0;
      current_audio_serial_ = 0;
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
      std::scoped_lock lock(audio_queue_mutex_);
      playback_ack_queue_.push_back(
          PlaybackAcknowledgementItem{turn_id, generation});
    }
    audio_queue_condition_.notify_one();
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
          || turn->second.segments.empty()) {
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
    g_input_state.ResetDisconnected();
    NotifyInputRuntimeStateChanged();
    {
      std::scoped_lock lock(audio_queue_mutex_);
      audio_queue_.clear();
      playback_ack_queue_.clear();
      current_audio_turn_id_.clear();
      current_audio_message_id_.clear();
      current_audio_generation_ = 0;
      current_audio_serial_ = 0;
    }
    StopCurrentAudio();
    if (on_output_segment_reset_) {
      on_output_segment_reset_(connection_generation_.load());
    }
  }

  void HandleTransportClosed(std::uint64_t generation) {
    if (closing_.load() || generation != connection_generation_.load()) {
      return;
    }
    std::cerr << "[runtime] websocket closed\n";
    g_runtime_connected.store(false);
    g_input_state.SetStatusText(L"离线");
    NotifyInputRuntimeStateChanged();
    NotifyInputConnectionChanged();
    pending_closed_generation_.store(generation);
    StopCurrentAudio();
    audio_queue_condition_.notify_all();
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
      g_input_state.SetPreviewText(std::wstring(
          segment.text.content.begin(), segment.text.content.end()));
      g_input_state.SetFeedbackAvailable(false);
      g_input_state.SetFeedbackApproved(false);
      g_input_state.SetStatusText(L"播放中");
      NotifyInputRuntimeStateChanged();
    }
    const auto generation = connection_generation_.load();
    NativeSegmentClock clock;
    clock.turn_id = turn_id;
    clock.message_id = segment.envelope.message_id;
    clock.sequence = segment.sequence;
    clock.started_at_seconds = NowSeconds();
    clock.generation = generation;
    if (!RegisterSegment(segment, generation)) {
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

  void AudioWorkerLoop() {
    while (true) {
      AudioQueueItem item;
      std::string acknowledgement_turn_id;
      std::uint64_t acknowledgement_generation = 0;
      bool send_acknowledgement = false;
      {
        std::unique_lock lock(audio_queue_mutex_);
        audio_queue_condition_.wait(lock, [this] {
          return closing_.load() || pending_closed_generation_.load() != 0
              || !playback_ack_queue_.empty() || !audio_queue_.empty();
        });
        if (closing_.load()) {
          return;
        }
        if (pending_closed_generation_.load() != 0) {
          lock.unlock();
          ProcessPendingTransportClosed();
          continue;
        }
        if (!playback_ack_queue_.empty()) {
          auto acknowledgement = std::move(playback_ack_queue_.front());
          playback_ack_queue_.pop_front();
          acknowledgement_turn_id = std::move(acknowledgement.turn_id);
          acknowledgement_generation = acknowledgement.generation;
          send_acknowledgement = true;
        } else {
          item = std::move(audio_queue_.front());
          audio_queue_.pop_front();
        }
      }
      if (send_acknowledgement) {
        TrySendPlaybackAcknowledgement(
            acknowledgement_turn_id, acknowledgement_generation);
        continue;
      }

      if (item.generation != connection_generation_.load()) {
        continue;
      }
      if (!IsSegmentPlaybackOpen(item)) {
        continue;
      }

      std::string playback_failure_reason;
      const auto playback = PlayAudioUrl(
          item.segment.audio.url, playback_failure_reason);
      if (playback) {
        std::scoped_lock lock(audio_queue_mutex_);
        current_audio_turn_id_ = item.turn_id;
        current_audio_message_id_ = item.message_id;
        current_audio_generation_ = item.generation;
        current_audio_serial_ = playback->serial;
      }
      if (item.generation != connection_generation_.load()
          || pending_closed_generation_.load() == item.generation) {
        if (playback) {
          StopCurrentAudio(playback->serial);
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
        StopCurrentAudio(playback->serial);
        ClearCurrentAudio(item, playback->serial);
        continue;
      }

      bool motion_dispatch_failed = false;
      {
        std::scoped_lock transport_lock(transport_mutex_);
        if (closing_.load()
            || item.generation != connection_generation_.load()) {
          StopCurrentAudio(playback->serial);
          ClearCurrentAudio(item, playback->serial);
          continue;
        }
        // Keep the final dispatch ordered before or after turn retirement.
        std::scoped_lock playback_lock(playback_mutex_);
        const auto turn = playback_turns_.find(item.turn_id);
        if (turn == playback_turns_.end()
            || turn->second.generation != item.generation
            || !turn->second.segments.contains(item.message_id)) {
          StopCurrentAudio(playback->serial);
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
             && g_audio_serial.load() == playback->serial
             && NowSeconds() < deadline) {
        std::this_thread::sleep_for(std::chrono::milliseconds(25));
      }
      if (pending_closed_generation_.load() == item.generation) {
        ProcessPendingTransportClosed();
        continue;
      }
      if (closing_.load()
          || g_audio_serial.load() != playback->serial) {
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

  ag99::runtime::WinHttpWebSocketClient websocket_;
  MicrophoneCapture microphone_;
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
  std::mutex audio_queue_mutex_;
  std::mutex audio_join_mutex_;
  std::condition_variable audio_queue_condition_;
  std::deque<AudioQueueItem> audio_queue_;
  std::deque<PlaybackAcknowledgementItem> playback_ack_queue_;
  std::string current_audio_turn_id_;
  std::string current_audio_message_id_;
  std::uint64_t current_audio_generation_ = 0;
  std::uint64_t current_audio_serial_ = 0;
  std::atomic<bool> closing_{false};
  std::thread audio_worker_;
  std::atomic<std::uint64_t> next_turn_id_{1};
  std::atomic<std::uint64_t> next_feedback_id_{1};
  std::string last_input_turn_id_;
  std::optional<AssistantSegment> latest_assistant_segment_;
  std::atomic<std::uint64_t> connection_generation_{0};
  std::atomic<std::uint64_t> pending_closed_generation_{0};
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

csmByte* LoadFileFromPath(
    const std::filesystem::path& path, csmSizeInt* size) {
  if (path.empty() || !size) {
    return nullptr;
  }

  FILE* file = nullptr;
  if (_wfopen_s(&file, path.c_str(), L"rb") != 0 || !file) {
    *size = 0;
    return nullptr;
  }

  std::fseek(file, 0, SEEK_END);
  const long length = std::ftell(file);
  std::fseek(file, 0, SEEK_SET);
  if (length <= 0) {
    std::fclose(file);
    *size = 0;
    return nullptr;
  }

  auto* buffer = static_cast<csmByte*>(
      std::malloc(static_cast<std::size_t>(length)));
  if (!buffer || std::fread(
          buffer, 1, static_cast<std::size_t>(length), file)
          != static_cast<std::size_t>(length)) {
    std::free(buffer);
    std::fclose(file);
    *size = 0;
    return nullptr;
  }

  std::fclose(file);
  *size = static_cast<csmSizeInt>(length);
  return buffer;
}

csmByte* LoadFile(const std::string path, csmSizeInt* size) {
  if (size) {
    *size = 0;
  }
  const auto sdk_path = PathFromUtf8(path);
  if (!sdk_path || !size) {
    return nullptr;
  }

  constexpr std::string_view shader_prefix = "FrameworkShaders/";
  if (path.starts_with(shader_prefix)) {
    const auto relative_shader = PathFromUtf8(path.substr(shader_prefix.size()));
    if (!relative_shader) {
      return nullptr;
    }

    // Prefer assets shipped next to the executable so a packaged build does
    // not depend on the SDK location used at compile time.
    const auto local_shader = ExecutableDirectory() / *relative_shader;
    std::error_code error;
    if (std::filesystem::is_regular_file(local_shader, error)) {
      if (auto* buffer = LoadFileFromPath(local_shader, size)) {
        return buffer;
      }
    }
    if (!g_shader_directory.empty()) {
      return LoadFileFromPath(g_shader_directory / *relative_shader, size);
    }
  }

  return LoadFileFromPath(*sdk_path, size);
}

void ReleaseFile(csmByte* buffer) {
  std::free(buffer);
}

bool ReadFile(const std::filesystem::path& path, std::vector<csmByte>& output) {
  csmSizeInt size = 0;
  csmByte* buffer = LoadFileFromPath(path, &size);
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
      std::cerr << "Failed to read model setting: "
                << PathToUtf8(model_json) << '\n';
      return false;
    }

    _setting = new CubismModelSettingJson(
        setting_bytes.data(), static_cast<csmSizeInt>(setting_bytes.size()));
    const std::filesystem::path model_dir = model_json.parent_path();

    const char* model_file_name = _setting->GetModelFileName();
    std::optional<std::filesystem::path> relative_moc_path;
    if (model_file_name) {
      relative_moc_path = PathFromUtf8(model_file_name);
    }
    if (!relative_moc_path) {
      std::cerr << "Model setting has an invalid UTF-8 moc path\n";
      return false;
    }
    const std::filesystem::path moc_path = model_dir / *relative_moc_path;
    std::vector<csmByte> moc_bytes;
    if (!ReadFile(moc_path, moc_bytes)) {
      std::cerr << "Failed to read model moc: " << PathToUtf8(moc_path) << '\n';
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

    std::cout << "Loaded Live2D model: " << PathToUtf8(model_json) << '\n';
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
    _pending_physics_response_protected_parameter_ids =
        std::move(protected_parameter_ids);
    std::cerr << "[motion] model sync received\n";
  }

  ag99::runtime::DesktopSettingsResult HandleDesktopSettingsQuery(
      const ag99::runtime::DesktopSettingsQuery& query) {
    ag99::runtime::DesktopSettingsResult result{
        query.request_id, query.key, std::nullopt, {}};
    if (query.key != "live2d_physics_response_scale") {
      result.error = "desktop_setting_unsupported";
      return result;
    }
    std::scoped_lock lock(_motion_mutex);
    if (query.action == "set") {
      const auto parsed = ParseDesktopSettingNumber(query.value.value_or(""));
      if (!parsed) {
        result.error = "desktop_setting_value_invalid";
        return result;
      }
      if (*parsed < 0.5 || *parsed > 2.0) {
        result.error = "desktop_setting_value_out_of_range";
        return result;
      }
      // Translate normalizeLive2dPresentationSettings; round, do not snap to step.
      _physics_response_scale_setting = std::round(*parsed * 100.0) / 100.0;
      _pending_physics_response_scale = _physics_response_scale_setting;
    }
    std::array<char, 32> value_text{};
    const auto formatted = std::to_chars(
        value_text.data(), value_text.data() + value_text.size(),
        _physics_response_scale_setting);
    result.entry = ag99::runtime::DesktopSettingsEntry{
        std::string(value_text.data(), formatted.ptr), {}, 0.5, 2.0, 0.05};
    return result;
  }

  void QueueOutputSegment(
      ag99::runtime::OutputSegment segment,
      std::optional<NativeSegmentClock> clock = std::nullopt) {
    std::scoped_lock lock(_motion_mutex);
    if (!clock) {
      clock = NativeSegmentClock{
          .turn_id = segment.envelope.turn_id.value_or(""),
          .message_id = segment.envelope.message_id,
          .sequence = segment.sequence,
          .started_at_seconds = NowSeconds(),
          .generation = _connection_generation};
    }
    if (clock && clock->generation != 0
        && clock->generation != _connection_generation) {
      return;
    }
    if (segment.motion.state != ag99::runtime::MotionSlot::State::Present) {
      return;
    }
    if (!_model || !_model->GetModel()) {
      QueueMotionTerminalLocked(
          *clock, false, "native_model_unavailable");
      return;
    }
    InterruptMotionPlansLocked("motion_plan_replaced");
    const auto& payload = segment.motion.payload;
    const auto schema = ReadString(payload, "schema_version");
    if (schema == std::string(ag99::runtime::kParameterPlanSchema)) {
      _pending_parameter_plan = std::move(segment);
      _pending_parameter_clock = std::move(clock);
      std::cerr << "[motion] parameter plan queued\n";
      return;
    }
    _pending_motion_segment = std::move(segment);
    _pending_motion_clock = std::move(clock);
    std::cerr << "[motion] intent queued\n";
  }

  std::vector<NativeSegmentTerminal> TakeMotionTerminals() {
    std::scoped_lock lock(_motion_mutex);
    std::vector<NativeSegmentTerminal> terminals;
    terminals.reserve(_segment_terminals.size());
    for (auto& terminal : _segment_terminals) {
      terminals.push_back(std::move(terminal));
    }
    _segment_terminals.clear();
    return terminals;
  }

  void CancelTurn(const std::string& turn_id) {
    std::scoped_lock lock(_motion_mutex);
    if (_pending_motion_clock
        && _pending_motion_clock->turn_id == turn_id) {
      _pending_motion_segment.reset();
      _pending_motion_clock.reset();
    }
    if (_active_motion && _active_motion->clock.turn_id == turn_id) {
      _active_motion.reset();
    }
    if (_pending_parameter_clock
        && _pending_parameter_clock->turn_id == turn_id) {
      _pending_parameter_plan.reset();
      _pending_parameter_clock.reset();
    }
    if (_active_parameter_plan
        && _active_parameter_plan->clock.turn_id == turn_id) {
      _active_parameter_plan.reset();
    }
  }

  void ResetRuntimeSegments(std::uint64_t generation) {
    std::scoped_lock lock(_motion_mutex);
    _connection_generation = generation;
    _pending_motion_segment.reset();
    _pending_motion_clock.reset();
    _active_motion.reset();
    _pending_parameter_plan.reset();
    _pending_parameter_clock.reset();
    _active_parameter_plan.reset();
    _segment_terminals.clear();
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
  static std::optional<double> ParseDesktopSettingNumber(
      const std::string& input) {
    // Translate parseFiniteNumber (String.trim + Number), including radix
    // literals. C strtod alone would also accept JS-invalid hex exponents.
    constexpr std::wstring_view whitespace =
        L"\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004"
        L"\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f"
        L"\u205f\u3000\ufeff";
    const auto wide = WidenUtf8(input);
    const auto first = wide.find_first_not_of(whitespace);
    if (first == std::wstring::npos) {
      return std::nullopt;
    }
    const auto last = wide.find_last_not_of(whitespace);
    std::string value;
    value.reserve(last - first + 1);
    for (auto index = first; index <= last; ++index) {
      if (wide[index] > 0x7f) {
        return std::nullopt;
      }
      value.push_back(static_cast<char>(wide[index]));
    }
    int radix = 0;
    if (value.size() > 2 && value[0] == '0') {
      if (value[1] == 'x' || value[1] == 'X') radix = 16;
      if (value[1] == 'o' || value[1] == 'O') radix = 8;
      if (value[1] == 'b' || value[1] == 'B') radix = 2;
    }
    if (radix != 0) {
      double number = 0.0;
      for (std::size_t index = 2; index < value.size(); ++index) {
        const auto character = value[index];
        const int digit = character >= '0' && character <= '9'
            ? character - '0'
            : character >= 'a' && character <= 'f'
                ? character - 'a' + 10
                : character >= 'A' && character <= 'F'
                    ? character - 'A' + 10 : -1;
        if (digit < 0 || digit >= radix) {
          return std::nullopt;
        }
        number = number * radix + digit;
      }
      return std::isfinite(number)
          ? std::optional<double>(number) : std::nullopt;
    }
    if (value.find_first_of("xXpP") != std::string::npos) {
      return std::nullopt;
    }
    char* end = nullptr;
    const auto number = std::strtod(value.c_str(), &end);
    if (end != value.c_str() + value.size() || !std::isfinite(number)) {
      return std::nullopt;
    }
    return number;
  }

  void QueueMotionTerminalLocked(
      const NativeSegmentClock& clock,
      bool success,
      std::string reason = {}) {
    if (clock.turn_id.empty() || clock.message_id.empty()) {
      return;
    }
    _segment_terminals.push_back(NativeSegmentTerminal{
        clock, success, std::move(reason)});
  }

  void InterruptMotionPlansLocked(const std::string& reason) {
    if (_pending_motion_clock) {
      QueueMotionTerminalLocked(*_pending_motion_clock, false, reason);
    }
    if (_active_motion) {
      QueueMotionTerminalLocked(_active_motion->clock, false, reason);
    }
    if (_pending_parameter_clock) {
      QueueMotionTerminalLocked(*_pending_parameter_clock, false, reason);
    }
    if (_active_parameter_plan) {
      QueueMotionTerminalLocked(
          _active_parameter_plan->clock, false, reason);
    }
    _pending_motion_segment.reset();
    _pending_motion_clock.reset();
    _active_motion.reset();
    _pending_parameter_plan.reset();
    _pending_parameter_clock.reset();
    _active_parameter_plan.reset();
  }

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
    NativeSegmentClock clock;
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
    NativeSegmentClock clock;
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
      const ag99::runtime::OutputSegment& segment,
      const NativeSegmentClock& clock) const {
    if (segment.motion.state != ag99::runtime::MotionSlot::State::Present) {
      std::cerr << "[motion] output segment has no parameter plan\n";
      return std::nullopt;
    }
    const auto& payload = segment.motion.payload;
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
        .started_at = clock.started_at_seconds,
        .duration_ms = duration_ms,
        .blend_in_ms = blend_in_ms,
        .hold_ms = hold_ms,
        .blend_out_ms = blend_out_ms,
        .curve_preset = ReadString(*timing, "curve_preset"),
        .clock = clock,
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
    if (_pending_physics_response_protected_parameter_ids) {
      _model->SetPhysicsResponseProtectedParameterIds(
          *_pending_physics_response_protected_parameter_ids);
      _pending_physics_response_protected_parameter_ids.reset();
    }
    if (_pending_physics_response_scale) {
      _model->SetPhysicsResponseScale(
          static_cast<csmFloat32>(*_pending_physics_response_scale));
      _pending_physics_response_scale.reset();
    }
    if (_pending_parameter_plan) {
      const auto clock = _pending_parameter_clock.value_or(
          NativeSegmentClock{
              .turn_id = _pending_parameter_plan->envelope.turn_id.value_or(""),
              .message_id = _pending_parameter_plan->envelope.message_id,
              .sequence = _pending_parameter_plan->sequence,
              .started_at_seconds = NowSeconds(),
              .generation = _connection_generation});
      const auto parsed = ParseParameterPlan(
          *_pending_parameter_plan, clock);
      const auto turn_id =
          _pending_parameter_plan->envelope.turn_id.value_or("");
      _pending_parameter_plan.reset();
      _pending_parameter_clock.reset();
      if (parsed) {
        if (!parsed->expression_id.empty()
            && !_model->StartExpressionById(parsed->expression_id)) {
          std::cerr << "[motion] expression resource not found: "
                    << parsed->expression_id << '\n';
          QueueMotionTerminalLocked(
              parsed->clock,
              false,
              "expression_resource_not_found:" + parsed->expression_id);
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
        QueueMotionTerminalLocked(
            clock, false, "parameter_plan_rejected");
      }
    }
    const auto fail_active_parameter_plan = [this](std::string reason) {
      if (_active_parameter_plan) {
        QueueMotionTerminalLocked(
            _active_parameter_plan->clock, false, std::move(reason));
        _active_parameter_plan.reset();
      }
    };
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
      fail_active_parameter_plan("lip_sync_intensity_invalid");
      return false;
    }
    if (lip_sync_active) {
      for (const auto parameter_index : _model->LipSyncParameterIndices()) {
        if (parameter_index < 0
            || parameter_index >= cubism_model->GetParameterCount()) {
          std::cerr << "[parameter_mixer] lip sync parameter is not writable\n";
          fail_active_parameter_plan("lip_sync_parameter_not_writable");
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
          fail_active_parameter_plan("lip_sync_parameter_range_invalid");
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
      fail_active_parameter_plan("parameter_frame_rejected");
      return false;
    }
    if (clear_active_plan && direct_presentation_settled) {
      QueueMotionTerminalLocked(
          _active_parameter_plan->clock, true);
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
      const ag99::runtime::OutputSegment& segment,
      const NativeSegmentClock& clock) const {
    if (segment.motion.state != ag99::runtime::MotionSlot::State::Present) {
      std::cerr << "[motion] output segment has no motion payload\n";
      return std::nullopt;
    }
    const auto& intent = segment.motion.payload;
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
    plan.started_at = clock.started_at_seconds;
    plan.clock = clock;
    return plan;
  }

  void ApplyQueuedMotion() {
    std::scoped_lock lock(_motion_mutex);
    if (!_model || !_model->GetModel()) {
      return;
    }
    if (_pending_motion_segment) {
      const auto clock = _pending_motion_clock.value_or(
          NativeSegmentClock{
              .turn_id = _pending_motion_segment->envelope.turn_id.value_or(""),
              .message_id = _pending_motion_segment->envelope.message_id,
              .sequence = _pending_motion_segment->sequence,
              .started_at_seconds = NowSeconds(),
              .generation = _connection_generation});
      std::optional<MotionPlan> plan;
      try {
        plan = CompileMotionPlan(*_pending_motion_segment, clock);
      } catch (const std::exception& error) {
        std::cerr << "[motion] compile threw " << typeid(error).name()
                  << ": " << error.what() << '\n';
      } catch (...) {
        std::cerr << "[motion] compile threw an unknown exception\n";
      }
      const auto turn_id =
          _pending_motion_segment->envelope.turn_id.value_or("");
      _pending_motion_segment.reset();
      _pending_motion_clock.reset();
      if (plan) {
        _active_motion = *plan;
        ReleaseThinkingSwayLocked(turn_id);
        std::cerr << "[motion] compiled " << _active_motion->tracks.size()
                  << " parameter tracks for "
                  << _active_motion->duration_ms << " ms\n";
      } else {
        QueueMotionTerminalLocked(clock, false, "motion_plan_rejected");
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
      QueueMotionTerminalLocked(_active_motion->clock, true);
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
  std::optional<ag99::runtime::OutputSegment> _pending_motion_segment;
  std::optional<NativeSegmentClock> _pending_motion_clock;
  std::optional<ParameterPlan> _active_parameter_plan;
  std::optional<ag99::runtime::OutputSegment> _pending_parameter_plan;
  std::optional<NativeSegmentClock> _pending_parameter_clock;
  std::deque<NativeSegmentTerminal> _segment_terminals;
  std::uint64_t _connection_generation = 0;
  std::optional<std::unordered_set<std::string>>
      _pending_physics_response_protected_parameter_ids;
  double _physics_response_scale_setting = 1.0;
  std::optional<double> _pending_physics_response_scale;
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
  g_tray_controller.Add(window, kTrayMessage, L"AG99live Native Runtime");
}

void RemoveTrayIcon() {
  g_tray_controller.Remove();
}

void SetClickThrough(HWND window, bool enabled);
void ShowInputWindow(HINSTANCE instance);

std::string LogPathForMessage() {
  const std::wstring& wide = ag99::live2d::LogFilePath();
  if (wide.empty()) {
    return "unavailable";
  }
  const int length = WideCharToMultiByte(
      CP_UTF8, 0, wide.c_str(), static_cast<int>(wide.size()), nullptr, 0,
      nullptr, nullptr);
  if (length <= 0) {
    return "unavailable";
  }
  std::string result(static_cast<std::size_t>(length), '\0');
  WideCharToMultiByte(
      CP_UTF8, 0, wide.c_str(), static_cast<int>(wide.size()), result.data(),
      length, nullptr, nullptr);
  return result;
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
  AppendMenuW(menu, MF_STRING, kTrayInputWindow, L"打开输入框");
  AppendMenuW(menu, MF_STRING, kTrayDemoText, L"发送演示文本");
  AppendMenuW(
      menu,
      MF_STRING,
      kTrayMicToggle,
      g_microphone_running && g_microphone_running()
          ? L"停止麦克风"
          : L"开始麦克风");
  AppendMenuW(
      menu, MF_STRING, kTrayClickThrough,
      g_click_through ? L"关闭点击穿透" : L"开启点击穿透");
  AppendMenuW(menu, MF_SEPARATOR, 0, nullptr);
  AppendMenuW(menu, MF_STRING, kTrayOpenLog, L"打开日志目录");
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
    case WM_NCHITTEST:
      // WS_EX_TRANSPARENT changes paint ordering, not hit testing. Return
      // HTTRANSPARENT as well so the overlay does not consume mouse input
      // while click-through mode is enabled.
      if (g_click_through) {
        return HTTRANSPARENT;
      }
      return DefWindowProcW(window, message, wparam, lparam);
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
        case kTrayInputWindow:
          ShowInputWindow(
              reinterpret_cast<HINSTANCE>(
                  GetWindowLongPtrW(window, GWLP_HINSTANCE)));
          return 0;
        case kTrayClickThrough:
          SetClickThrough(window, !g_click_through);
          return 0;
        case kTrayOpenLog: {
          const std::wstring& directory = ag99::live2d::LogDirectory();
          if (directory.empty()) {
            MessageBoxW(
                window, L"日志目录不可用。", kWindowTitle, MB_OK | MB_ICONWARNING);
          } else {
            ShellExecuteW(
                nullptr, L"open", directory.c_str(), nullptr, nullptr,
                SW_SHOWNORMAL);
          }
          return 0;
        }
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

// --- Click-through -------------------------------------------------------
//
// WS_EX_TRANSPARENT makes the whole window forward its mouse input to the
// window underneath. It is the practical choice for a transparent Live2D
// overlay: nothing else can receive clicks while it is on, so it is a tray
// toggle rather than a permanent mode.

void SetClickThrough(HWND window, bool enabled) {
  if (!window) {
    return;
  }
  const LONG_PTR previous = GetWindowLongPtrW(window, GWL_EXSTYLE);
  LONG_PTR style = previous;
  if (enabled) {
    style |= WS_EX_TRANSPARENT;
  } else {
    style &= ~static_cast<LONG_PTR>(WS_EX_TRANSPARENT);
  }
  if (style != previous) {
    SetWindowLongPtrW(window, GWL_EXSTYLE, style);
  }
  // Extended styles only take effect after the window is re-applied.
  if (!SetWindowPos(
      window, HWND_TOPMOST, 0, 0, 0, 0,
      SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_FRAMECHANGED)) {
    if (style != previous) {
      SetWindowLongPtrW(window, GWL_EXSTYLE, previous);
    }
    AG99_ERROR("clickthrough", "failed to apply the window input style");
    return;
  }
  g_click_through = enabled;
  AG99_INFO(
      "clickthrough", enabled ? "enabled" : "disabled");
}

// --- Text input window ---------------------------------------------------

constexpr wchar_t kInputClassName[] = L"AG99liveTextInputWindow";
constexpr UINT kInputSend = 2001;
constexpr UINT kInputMicToggle = 2003;
constexpr UINT kInputFeedback = 2004;
constexpr UINT kInputInterrupt = 2005;
constexpr int kInputControlId = 100;
constexpr int kInputMessageId = 101;
constexpr int kInputStatusId = 102;

ag99::platform::InputOverlayResources g_input_resources;

void SetInputStatus(HWND window, std::wstring_view text) {
  ag99::platform::SetInputOverlayStatus(window, kInputStatusId, text);
}

void SetInputPreview(HWND window, std::wstring_view text) {
  ag99::platform::SetInputOverlayPreview(window, kInputMessageId, text);
}

void SetInputConnectionLabels(HWND window) {
  if (!window) {
    return;
  }
  const ag99::platform::InputOverlayViewIds ids{
      kInputMessageId,
      kInputStatusId,
      kInputFeedback,
  };
  ag99::platform::ApplyInputOverlaySnapshot(
      window, g_runtime_connected.load(), g_input_state.Snapshot(), ids);
}

void SubmitInputText(HWND window) {
  const HWND edit = GetDlgItem(window, kInputControlId);
  if (!edit) {
    return;
  }
  const int length = GetWindowTextLengthW(edit);
  if (length <= 0) {
    SetInputStatus(window, L"请输入文本");
    return;
  }
  std::wstring buffer(static_cast<std::size_t>(length) + 1, L'\0');
  const int copied = GetWindowTextW(
      edit, buffer.data(), static_cast<int>(buffer.size()));
  buffer.resize(copied > 0 ? static_cast<std::size_t>(copied) : 0);
  buffer = ag99::platform::TrimInputText(std::move(buffer));
  const std::string text = ag99::platform::InputTextToUtf8(buffer);
  if (text.empty()) {
    SetInputStatus(window, L"请输入文本");
    return;
  }
  if (!g_send_text || !g_send_text(text)) {
    SetInputStatus(window, L"发送失败：未连接到 Adapter");
    AG99_ERROR("input", "send failed for user text");
    return;
  }
  AG99_INFO("input", std::string("sent user text, ")
      + std::to_string(text.size()) + " bytes");
  SetWindowTextW(edit, L"");
  SetInputStatus(window, L"已发送");
}

LRESULT CALLBACK InputEditProc(
    HWND edit, UINT message, WPARAM wparam, LPARAM lparam) {
  if (message == WM_KEYDOWN && wparam == VK_RETURN) {
    HIMC context = ImmGetContext(edit);
    const bool composing = context != nullptr
        && ImmGetCompositionStringW(context, GCS_COMPSTR, nullptr, 0) > 0;
    if (context) {
      ImmReleaseContext(edit, context);
    }
    if (composing) {
      const auto previous = reinterpret_cast<WNDPROC>(
          GetPropW(edit, L"AG99liveInputPreviousProc"));
      return previous
          ? CallWindowProcW(previous, edit, message, wparam, lparam)
          : DefWindowProcW(edit, message, wparam, lparam);
    }
    if (const HWND parent = GetParent(edit)) {
      SubmitInputText(parent);
    }
    return 0;
  }

  const auto previous = reinterpret_cast<WNDPROC>(
      GetPropW(edit, L"AG99liveInputPreviousProc"));
  if (previous) {
    return CallWindowProcW(previous, edit, message, wparam, lparam);
  }
  return DefWindowProcW(edit, message, wparam, lparam);
}

LRESULT CALLBACK InputWindowProc(
    HWND window, UINT message, WPARAM wparam, LPARAM lparam) {
  switch (message) {
    case WM_COMMAND:
      if (LOWORD(wparam) == kInputSend) {
        SubmitInputText(window);
        return 0;
      }
      if (LOWORD(wparam) == kInputMicToggle) {
        if (g_toggle_microphone) {
          g_toggle_microphone();
          SetInputStatus(
              window,
              g_microphone_running && g_microphone_running()
                  ? L"麦克风已开启" : L"麦克风已关闭");
        } else {
          SetInputStatus(window, L"麦克风不可用");
        }
        return 0;
      }
      if (LOWORD(wparam) == kInputFeedback) {
        const bool sent = g_approve_latest_segment && g_approve_latest_segment();
        SetInputStatus(window, sent ? L"已赞同最近一条回复" : L"暂无可赞同的回复");
        return 0;
      }
      if (LOWORD(wparam) == kInputInterrupt) {
        const bool sent = g_interrupt_turn && g_interrupt_turn();
        SetInputStatus(window, sent ? L"已打断当前回复" : L"当前没有可打断的回复");
        return 0;
      }
      break;
    case WM_NCHITTEST: {
      POINT point{GET_X_LPARAM(lparam), GET_Y_LPARAM(lparam)};
      ScreenToClient(window, &point);
      RECT drag_zone{0, 0, 420, 84};
      return PtInRect(&drag_zone, point) ? HTCAPTION : HTCLIENT;
    }
    case WM_ERASEBKGND:
      return 1;
    case WM_PAINT: {
      PAINTSTRUCT paint{};
      const HDC dc = BeginPaint(window, &paint);
      RECT client{};
      GetClientRect(window, &client);
      if (!g_input_resources.background_brush) {
        g_input_resources.background_brush = CreateSolidBrush(RGB(8, 9, 12));
      }
      ag99::platform::PaintInputOverlayBackground(
          dc, client, g_input_resources.background_brush);
      EndPaint(window, &paint);
      return 0;
    }
    case WM_CTLCOLORSTATIC: {
      const HDC dc = reinterpret_cast<HDC>(wparam);
      SetTextColor(dc, RGB(232, 234, 240));
      SetBkMode(dc, TRANSPARENT);
      return reinterpret_cast<LRESULT>(g_input_resources.background_brush);
    }
    case WM_CTLCOLOREDIT: {
      const HDC dc = reinterpret_cast<HDC>(wparam);
      SetTextColor(dc, RGB(238, 240, 246));
      SetBkColor(dc, RGB(19, 21, 26));
      if (!g_input_resources.edit_brush) {
        g_input_resources.edit_brush = CreateSolidBrush(RGB(19, 21, 26));
      }
      return reinterpret_cast<LRESULT>(g_input_resources.edit_brush);
    }
    case WM_NCPAINT: {
      // The TS composer uses a soft 1px border rather than the native
      // client-edge frame. Paint the control border ourselves.
      const HWND edit = GetDlgItem(window, kInputControlId);
      ag99::platform::PaintInputOverlayEditBorder(edit);
      return 0;
    }
    case WM_DRAWITEM: {
      if (ag99::platform::PaintInputOverlayButton(
          reinterpret_cast<const DRAWITEMSTRUCT*>(lparam),
          kInputSend,
          kInputMicToggle,
          kInputFeedback,
          kInputInterrupt)) {
        return TRUE;
      }
      break;
    }
    case kInputConnectionChanged:
    case kInputRuntimeStateChanged:
      SetInputConnectionLabels(window);
      return 0;
    case WM_DESTROY:
      {
        std::scoped_lock lock(g_input_window_mutex);
        g_input_window = nullptr;
      }
      ag99::platform::DestroyInputOverlayResources(g_input_resources);
      return 0;
    default:
      break;
  }
  return DefWindowProcW(window, message, wparam, lparam);
}

void ShowInputWindow(HINSTANCE instance) {
  HWND existing = nullptr;
  {
    std::scoped_lock lock(g_input_window_mutex);
    existing = g_input_window;
  }
  if (existing) {
    SetForegroundWindow(existing);
    SetWindowPos(
        existing, HWND_TOPMOST, 0, 0, 0, 0,
        SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
    return;
  }

  WNDCLASSEXW window_class{};
  window_class.cbSize = sizeof(window_class);
  window_class.lpfnWndProc = InputWindowProc;
  window_class.hInstance = instance;
  window_class.hCursor = LoadCursorW(nullptr, IDC_ARROW);
  window_class.hbrBackground = reinterpret_cast<HBRUSH>(COLOR_BTNFACE + 1);
  window_class.lpszClassName = kInputClassName;
  RegisterClassExW(&window_class);

  const int width = 420;
  const int height = 168;
  const int x = GetSystemMetrics(SM_CXSCREEN) - width - 28;
  const int y = GetSystemMetrics(SM_CYSCREEN) - height - 96;
  HWND window = CreateWindowExW(
      WS_EX_TOOLWINDOW | WS_EX_TOPMOST | WS_EX_LAYERED,
      kInputClassName,
      L"AG99live",
      WS_POPUP,
      x, y, width, height, nullptr, nullptr, instance, nullptr);
  if (!window) {
    AG99_ERROR("input", "failed to create the input window");
    return;
  }
  {
    std::scoped_lock lock(g_input_window_mutex);
    g_input_window = window;
  }
  SetLayeredWindowAttributes(window, 0, 255, LWA_ALPHA);
  SetWindowRgn(window, CreateRoundRectRgn(0, 0, width + 1, height + 1, 12, 12), TRUE);
  const HFONT font = static_cast<HFONT>(GetStockObject(DEFAULT_GUI_FONT));
  g_input_resources = ag99::platform::CreateInputOverlayResources(window, font);

  const ag99::platform::InputOverlayControlIds control_ids{
      kInputControlId,
      kInputMessageId,
      kInputStatusId,
      static_cast<int>(kInputMicToggle),
      static_cast<int>(kInputFeedback),
      static_cast<int>(kInputInterrupt),
      static_cast<int>(kInputSend),
  };
  const ag99::platform::InputOverlayControlFonts control_fonts{
      font,
      g_input_resources.message_font,
      g_input_resources.status_font,
      g_input_resources.input_font,
  };
  const auto controls = ag99::platform::CreateInputOverlayControls(
      window,
      instance,
      control_ids,
      control_fonts,
      &InputEditProc);

  ShowWindow(window, SW_SHOW);
  UpdateWindow(window);
  SetInputConnectionLabels(window);
  if (controls.input) {
    SetFocus(controls.input);
  }
  AG99_INFO("input", "text input window opened");
}

void NotifyInputConnectionChanged() {
  std::scoped_lock lock(g_input_window_mutex);
  if (g_input_window) {
    PostMessageW(g_input_window, kInputConnectionChanged, 0, 0);
  }
}

void NotifyInputRuntimeStateChanged() {
  std::scoped_lock lock(g_input_window_mutex);
  if (g_input_window) {
    PostMessageW(g_input_window, kInputRuntimeStateChanged, 0, 0);
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
      WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_NOREDIRECTIONBITMAP
          | WS_EX_LAYERED,
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
  if (!SetLayeredWindowAttributes(window, 0, 255, LWA_ALPHA)) {
    DestroyWindow(window);
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
            ag99::runtime::OutputSegment segment,
            std::optional<NativeSegmentClock> clock) {
          model.QueueOutputSegment(std::move(segment), std::move(clock));
        },
        [&model](std::uint64_t generation) {
          model.ResetRuntimeSegments(generation);
        },
        [&model](const std::string& turn_id) {
          model.StartThinkingSway(turn_id);
        },
        [&model](
            const std::string& turn_id,
            bool success,
            const std::string& reason) {
          if (!turn_id.empty() && !success) {
            std::cerr << "[runtime] backend turn failed: "
                      << (reason.empty() ? "unspecified" : reason) << '\n';
            model.CancelTurn(turn_id);
          }
          model.ReleaseThinkingSway(turn_id);
        },
        [&model](const std::string& turn_id) {
          model.CancelTurn(turn_id);
          model.ReleaseThinkingSway(turn_id);
        },
        [&model](const ag99::runtime::DesktopSettingsQuery& query) {
          return model.HandleDesktopSettingsQuery(query);
        });
    g_send_text = [&runtime](std::string text) {
      if (!runtime.SendText(text)) {
        std::cerr << "[runtime] failed to send text\n";
        return false;
      }
      return true;
    };
    g_toggle_microphone = [&runtime] {
      runtime.ToggleMicrophone();
    };
    g_microphone_running = [&runtime] {
      return runtime.MicrophoneRunning();
    };
    g_reconnect_adapter = [&runtime] {
      return runtime.Reconnect();
    };
    g_interrupt_turn = [&runtime] {
      return runtime.InterruptCurrentTurn();
    };
    g_approve_latest_segment = [&runtime] {
      return runtime.ApproveLatestAssistantSegment();
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
          for (auto& terminal : model.TakeMotionTerminals()) {
            runtime.NotifyMotionTerminal(std::move(terminal));
          }
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
    g_reconnect_adapter = {};
    g_interrupt_turn = {};
    g_approve_latest_segment = {};
  }

  StopCurrentAudio();
  StopCubism();
  surface.Shutdown();
  HWND input_window = nullptr;
  {
    std::scoped_lock lock(g_input_window_mutex);
    input_window = g_input_window;
  }
  if (input_window) {
    DestroyWindow(input_window);
  }
  DestroyWindow(window);
  UnregisterClassW(kInputClassName, instance);
  UnregisterClassW(kWindowClassName, instance);
  AG99_INFO("host", std::string("render host stopped, exit=")
      + std::to_string(result_code));
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
  ag99::live2d::LogInitialize();
  ag99::live2d::LogCaptureStderr();
  AG99_INFO("host", "render host starting");
  AG99_INFO("host", "log file: " + LogPathForMessage());

  const HRESULT com_result = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  if (FAILED(com_result) && com_result != RPC_E_CHANGED_MODE) {
    AG99_ERROR("host", "CoInitializeEx failed");
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
