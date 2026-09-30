#include <windows.h>
#include <dwmapi.h>
#include <d3d11.h>
#include <dxgi.h>
#include <mmsystem.h>
#include <shellapi.h>
#include <winhttp.h>
#include <windowsx.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <iostream>
#include <malloc.h>
#include <mutex>
#include <optional>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

#include "ag99/runtime/protocol.hpp"
#include "ag99/runtime/runtime_session.hpp"
#include "ag99/runtime/winhttp_websocket.hpp"
#include <CubismFramework.hpp>
#include <CubismModelSettingJson.hpp>
#include <Id/CubismIdManager.hpp>
#include <Model/CubismUserModel.hpp>
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

HWND g_window = nullptr;
NOTIFYICONDATAW g_tray_icon{};
bool g_tray_icon_added = false;
bool g_dragging = false;
POINT g_drag_cursor{};
POINT g_drag_origin{};
std::atomic<double> g_audio_end_seconds{0.0};
std::atomic<float> g_audio_level{0.0f};
std::mutex g_audio_file_mutex;
std::wstring g_audio_file;

double NowSeconds() {
  return std::chrono::duration<double>(
      std::chrono::steady_clock::now().time_since_epoch()).count();
}

void UpdateAudioLevel() {
  const double remaining = g_audio_end_seconds.load() - NowSeconds();
  if (remaining <= 0.0) {
    g_audio_level.store(0.0f);
    return;
  }
  const float level = 0.15f + 0.85f *
      static_cast<float>(0.5 + 0.5 * std::sin(NowSeconds() * 18.0));
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
  PlaySoundW(nullptr, nullptr, 0);
  if (!g_audio_file.empty()) {
    DeleteFileW(g_audio_file.c_str());
    g_audio_file.clear();
  }
  g_audio_end_seconds.store(0.0);
  g_audio_level.store(0.0f);
}

void PlayAudioUrl(const std::string& url) {
  std::vector<std::uint8_t> bytes;
  if (!DownloadHttp(url, bytes)) {
    std::cerr << "Failed to download audio: " << url << '\n';
    return;
  }
  const auto path = WriteTempAudio(bytes);
  if (!path) {
    return;
  }
  const double duration = ReadWavDuration(bytes).value_or(1.0);
  {
    std::scoped_lock lock(g_audio_file_mutex);
    PlaySoundW(nullptr, nullptr, 0);
    if (!g_audio_file.empty()) {
      DeleteFileW(g_audio_file.c_str());
    }
    g_audio_file = *path;
    PlaySoundW(g_audio_file.c_str(), nullptr, SND_FILENAME | SND_ASYNC | SND_NODEFAULT);
  }
  g_audio_end_seconds.store(NowSeconds() + duration);
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

class RuntimeBridge final {
public:
  RuntimeBridge()
      : session_({
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
        }) {}

  bool Connect(const std::string& url) {
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

  void Close() {
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
    if (segment.text.state == ag99::runtime::TextSlot::State::Present) {
      std::cout << "[assistant] " << segment.text.content << '\n';
    }
    if (segment.audio.state == ag99::runtime::AudioSlot::State::Present) {
      std::scoped_lock lock(worker_mutex_);
      audio_workers_.emplace_back([url = std::move(segment.audio.url)] {
        PlayAudioUrl(url);
      });
    }
  }

  ag99::runtime::WinHttpWebSocketClient websocket_;
  ag99::runtime::RuntimeProtocolSession session_;
  std::mutex worker_mutex_;
  std::vector<std::thread> audio_workers_;
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

    _model = new CubismUserModel();
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

    renderer->IsPremultipliedAlpha(false);
    std::cout << "Loaded Live2D model: " << model_json.string() << '\n';
    return true;
  }

  void UpdateAndDraw() {
    if (!_model || !_model->GetModel()) {
      return;
    }

    CubismModel* cubism_model = _model->GetModel();
    cubism_model->LoadParameters();
    UpdateAudioLevel();
    if (_mouth_parameter_index >= 0) {
      const float mouth = 0.08f + g_audio_level.load() * 0.92f;
      cubism_model->SetParameterValue(_mouth_parameter_index, mouth);
    }
    cubism_model->Update();
    cubism_model->SaveParameters();

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

private:
  CubismUserModel* _model = nullptr;
  CubismModelSettingJson* _setting = nullptr;
  std::vector<TextureResource> _textures;
  csmInt32 _mouth_parameter_index = -1;
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

int Run(HINSTANCE instance, const std::filesystem::path& model_json) {
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
    RuntimeBridge runtime;
    if (!model_json.empty() && !model.Load(model_json, width, height)) {
      result_code = 1;
    } else {
      if (!runtime.Connect("ws://127.0.0.1:12396")) {
        std::cerr << "[runtime] adapter connection unavailable; tray/render demo continues\n";
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
  if (arguments && argument_count > 1) {
    model_json = arguments[1];
  }
  if (arguments) {
    LocalFree(arguments);
  }
  const int result = Run(instance, model_json);
  if (SUCCEEDED(com_result)) {
    CoUninitialize();
  }
  return result;
}
