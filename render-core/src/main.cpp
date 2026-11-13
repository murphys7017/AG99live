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
#include <memory>
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
#include "ag99/native/settings_controller.hpp"
#include "ag99/native/runtime_coordinator.hpp"
#include "ag99/native/microphone_capture.hpp"
#include "ag99/native/audio_runtime.hpp"
#include "ag99/native/playback_ledger.hpp"
#include "ag99/native/motion_types.hpp"
#include "ag99/native/json_utils.hpp"
#include "ag99/native/motion_compiler.hpp"
#include "ag99/native/motion_scheduler.hpp"
#include "ag99/native/native_host.hpp"
#include "ag99/native/native_model.hpp"
#include "ag99/native/desktop_capture.hpp"
#include "ag99/native/spout_output.hpp"
#include "ag99/audio/audio_source.hpp"
#include "ag99/audio/speech_signal.hpp"
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
constexpr double kMaxIncrementalMotionLateTailSeconds = 1.8;

ag99::platform::TrayController g_tray_controller;
bool g_dragging = false;
POINT g_drag_cursor{};
POINT g_drag_origin{};
std::atomic<float> g_drag_x{0.0f};
std::atomic<float> g_drag_y{0.0f};
std::function<bool(std::string)> g_send_text;
std::function<void()> g_toggle_microphone;
std::function<bool()> g_microphone_running;
std::function<bool()> g_reconnect_adapter;
std::function<void(UINT, UINT)> g_resize_window;
std::function<bool()> g_interrupt_turn;
std::function<bool()> g_approve_latest_segment;
std::atomic<bool> g_runtime_connected{false};
std::mutex g_input_window_mutex;
HWND g_input_window = nullptr;
ag99::platform::InputOverlayState g_input_state;
ag99::platform::InputOverlayResources g_input_resources;
bool g_click_through = false;
ag99::native::AudioRuntime g_audio_runtime;

bool NativeIncrementalOutputEnabled() {
  static const bool enabled = [] {
    const auto* value = std::getenv("AG99_NATIVE_OLV");
    if (!value) {
      return false;
    }
    const std::string_view normalized(value);
    return normalized == "1" || normalized == "true"
        || normalized == "TRUE" || normalized == "on"
        || normalized == "ON";
  }();
  return enabled;
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

// The render host keeps this clock metadata outside the wire protocol. It is
// the shared time origin for one output segment's audio and motion paths.
using ag99::native::NativeSegmentClock;
using ag99::native::NativeSegmentTerminal;
using ag99::native::AudioPlayback;
using ag99::native::NativeRuntimeCoordinator;
using ag99::native::NativeModel;
using ag99::native::InteractionBinding;
using ag99::native::InteractionGazeState;
using ag99::native::InteractionSwayState;
using ag99::native::MotionPlan;
using ag99::native::MotionTrack;
using ag99::native::ParameterPlan;
using ag99::native::ParameterPlanBinding;
using ag99::native::ParameterPlanTrackPoint;
using ag99::native::ParameterPresentationState;
namespace json = ag99::native::json;
namespace motion = ag99::native::motion;
using motion::AxisMap;
using motion::AxisValue;
using motion::MotionScheduler;
using ag99::native::AudioQueueItem;
using ag99::native::IncrementalAudioJob;
using ag99::native::IncrementalSegmentPlaybackState;
using ag99::native::IncrementalWorkerState;
using ag99::native::PlaybackAcknowledgementItem;
using ag99::native::PlaybackAckSendResult;
using ag99::native::SegmentPlaybackState;
using ag99::native::TurnPlaybackState;

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

std::filesystem::path SpoutSenderPath() {
  const auto candidates = std::array<std::filesystem::path, 3>{
      ExecutableDirectory() / "spout" / "AG99liveSpoutSender.exe",
      ExecutableDirectory()
          / "../../../frontend/resources/spout/AG99liveSpoutSender.exe",
      std::filesystem::current_path()
          / "frontend/resources/spout/AG99liveSpoutSender.exe"};
  for (const auto& candidate : candidates) {
    if (std::filesystem::exists(candidate)) {
      return candidate;
    }
  }
  return candidates.front();
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
  UINT width = 640;
  UINT height = 820;
  ag99::native::NativeHost host({
      .tray = &g_tray_controller,
      .send_text = &g_send_text,
      .toggle_microphone = &g_toggle_microphone,
      .microphone_running = &g_microphone_running,
      .interrupt_turn = &g_interrupt_turn,
      .approve_latest_segment = &g_approve_latest_segment,
      .reconnect_adapter = &g_reconnect_adapter,
      .click_through = &g_click_through,
      .dragging = &g_dragging,
      .drag_cursor = &g_drag_cursor,
      .drag_origin = &g_drag_origin,
      .drag_x = &g_drag_x,
      .drag_y = &g_drag_y,
      .input_window_mutex = &g_input_window_mutex,
      .input_window = &g_input_window,
      .input_state = &g_input_state,
      .input_resources = &g_input_resources,
      .runtime_connected = [] { return g_runtime_connected.load(); },
      .resize_window = &g_resize_window,
  });
  HWND window = host.CreateMainWindow(
      instance, width, height, kWindowClassName, kWindowTitle);
  if (!window) {
    return 1;
  }
  ag99::live2d::D3D11CompositionSurface surface;
  if (FAILED(surface.Initialize(window, width, height))) {
    DestroyWindow(window);
    UnregisterClassW(kWindowClassName, instance);
    return 1;
  }
  host.AddTrayIcon(window);

  if (!StartCubism(surface.Device())) {
    host.RemoveTrayIcon();
    surface.Shutdown();
    DestroyWindow(window);
    UnregisterClassW(kWindowClassName, instance);
    return 1;
  }

  int result_code = 0;
  {
    ag99::native::NativeModelServices model_services;
    model_services.now_seconds = [] { return NowSeconds(); };
    model_services.path_from_utf8 = [](
        std::string_view value) { return PathFromUtf8(value); };
    model_services.path_to_utf8 = [](
        const std::filesystem::path& value) { return PathToUtf8(value); };
    model_services.read_file = [](
        const std::filesystem::path& path,
        std::vector<std::uint8_t>& output) {
      return ReadFile(path, output);
    };
    model_services.audio.update_audio_level = [](float delta_seconds, double now) {
      g_audio_runtime.UpdateAudioLevel(delta_seconds, now);
    };
    model_services.audio.speech_audio_gain = [](std::string_view axis_id) {
      return g_audio_runtime.SpeechAudioGain(axis_id);
    };
    model_services.audio.speech_lip_sync_intensity = [] {
      return g_audio_runtime.SpeechLipSyncIntensity();
    };
    model_services.audio.audio_end_seconds = [] {
      return g_audio_runtime.AudioEndSeconds();
    };
    model_services.audio.set_speech_volume = [](float volume) {
      g_audio_runtime.SetSpeechVolume(volume);
    };
    model_services.drag_x = &g_drag_x;
    model_services.drag_y = &g_drag_y;
    NativeModel model(std::move(model_services));
    g_resize_window = [&](UINT next_width, UINT next_height) {
      if (next_width < 320 || next_height < 480
          || next_width > 4096 || next_height > 4096) {
        return;
      }
      if (FAILED(surface.Resize(next_width, next_height))) {
        return;
      }
      width = next_width;
      height = next_height;
      model.Resize(width, height);
    };
    ag99::native::SpoutOutput spout(SpoutSenderPath());
    ag99::native::RuntimeCoordinatorServices services;
    services.native_incremental_output_enabled = [] {
      return NativeIncrementalOutputEnabled();
    };
    services.notify_input_connection_changed = [&host] {
      host.NotifyInputConnectionChanged();
    };
    services.notify_input_runtime_state_changed = [&host] {
      host.NotifyInputRuntimeStateChanged();
    };
    services.now_seconds = [] {
      return NowSeconds();
    };
    services.widen_utf8 = [](std::string_view value) {
      return WidenUtf8(value);
    };
    services.trim_ascii_text = [](std::string value) {
      return TrimAsciiText(std::move(value));
    };
    services.set_preview_text = [](std::wstring value) {
      g_input_state.SetPreviewText(std::move(value));
    };
    services.set_status_text = [](std::wstring value) {
      g_input_state.SetStatusText(std::move(value));
    };
    services.reset_input_disconnected = [] {
      g_input_state.ResetDisconnected();
    };
    services.set_feedback_available = [](bool value) {
      g_input_state.SetFeedbackAvailable(value);
    };
    services.set_feedback_approved = [](bool value) {
      g_input_state.SetFeedbackApproved(value);
    };
    services.runtime_connected = [] {
      return g_runtime_connected.load();
    };
    services.set_runtime_connected = [](bool value) {
      g_runtime_connected.store(value);
    };
    services.reset_speech_signal = [] {
      g_audio_runtime.ResetSpeechSignal();
    };
    services.play_audio_url = [](const std::string& url,
                                 std::string& failure_reason) {
      return g_audio_runtime.PlayAudioUrl(url, failure_reason);
    };
    services.stop_current_audio = [](std::optional<std::uint64_t> serial) {
      g_audio_runtime.StopCurrentAudio(serial);
    };
    services.stop_incremental_audio = [] {
      g_audio_runtime.StopIncrementalAudio();
    };
    services.capture_desktop_jpeg = [](
        std::string& error) {
      return ag99::native::CaptureDesktopJpeg(error);
    };
    services.audio_runtime = &g_audio_runtime;

    NativeRuntimeCoordinator runtime({
        .on_model_sync = [&model](ag99::runtime::ModelSync sync) {
          model.SetModelSync(sync.payload);
        },
        .on_pre_action = [&model](ag99::runtime::PreActionEvent event) {
          if (event.action == "ready") {
            if (!model.StartPreAction(event)) {
              std::cerr << "[motion] pre-action rejected by Native model\n";
            }
          } else {
            model.CancelPreAction(
                event.envelope.turn_id.value_or(""), event.request_id);
          }
        },
        .on_output_segment = [&model](
            ag99::runtime::OutputSegment segment,
            std::optional<NativeSegmentClock> clock) {
          model.QueueOutputSegment(std::move(segment), std::move(clock));
        },
        .on_output_segment_reset = [&model](std::uint64_t generation) {
          model.ResetRuntimeSegments(generation);
        },
        .on_turn_started = [&model](const std::string& turn_id) {
          model.CancelPreAction(turn_id);
          model.StartThinkingSway(turn_id);
        },
        .on_turn_finished = [&model](
            const std::string& turn_id,
            bool success,
            const std::string& reason) {
          if (!turn_id.empty() && !success) {
            std::cerr << "[runtime] backend turn failed: "
                      << (reason.empty() ? "unspecified" : reason) << '\n';
            model.CancelTurn(turn_id);
          }
          model.CancelPreAction(turn_id);
          model.ReleaseThinkingSway(turn_id);
        },
        .on_turn_interrupted = [&model](const std::string& turn_id) {
          model.CancelPreAction(turn_id);
          model.CancelTurn(turn_id);
          model.ReleaseThinkingSway(turn_id);
        },
        .on_desktop_settings_query = [&model, &spout](
            const ag99::runtime::DesktopSettingsQuery& query) {
          if (query.key == "spout_enabled") {
            return spout.HandleSetting(query);
          }
          return model.HandleDesktopSettingsQuery(query);
        }}, std::move(services));
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
          if (spout.enabled()) {
            std::vector<std::uint8_t> frame;
            if (SUCCEEDED(surface.ReadbackRgba(frame))) {
              spout.PublishFrame(width, height, std::move(frame));
            }
          }
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
    spout.Stop();
    g_send_text = {};
    g_toggle_microphone = {};
    g_microphone_running = {};
    g_reconnect_adapter = {};
    g_resize_window = {};
    g_interrupt_turn = {};
    g_approve_latest_segment = {};
  }

  g_audio_runtime.StopCurrentAudio();
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
  UnregisterClassW(kWindowClassName, instance);
  AG99_INFO("host", std::string("render host stopped, exit=")
      + std::to_string(result_code));
  return result_code;
}

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
