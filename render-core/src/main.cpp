#include <windows.h>
#include <dwmapi.h>
#include <d3d11.h>
#include <dxgi.h>
#include <shellapi.h>

#include <algorithm>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <iostream>
#include <malloc.h>
#include <string>
#include <vector>

#include <CubismFramework.hpp>
#include <CubismModelSettingJson.hpp>
#include <Model/CubismUserModel.hpp>
#include <Rendering/D3D11/CubismRenderer_D3D11.hpp>
#include <WICTextureLoader.h>

namespace {

using namespace Live2D::Cubism::Framework;

constexpr wchar_t kWindowClassName[] = L"AG99liveRenderCoreWindow";
constexpr wchar_t kWindowTitle[] = L"AG99live Native Render Core";

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

struct TextureResource {
  ID3D11Resource* resource = nullptr;
  ID3D11ShaderResourceView* view = nullptr;
};

void LogMessage(const csmChar* message) {
  if (message) {
    std::cerr << "[cubism] " << message << '\n';
  }
}

csmByte* LoadFile(const std::string path, csmSizeInt* size) {
  if (path.empty() || !size) {
    return nullptr;
  }

  FILE* file = nullptr;
  if (fopen_s(&file, path.c_str(), "rb") != 0 || !file) {
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
};

LRESULT CALLBACK WindowProc(HWND window, UINT message, WPARAM wparam, LPARAM lparam) {
  switch (message) {
    case WM_ERASEBKGND:
      return 1;
    case WM_DESTROY:
      PostQuitMessage(0);
      return 0;
    default:
      return DefWindowProcW(window, message, wparam, lparam);
  }
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
    ReleaseGraphics();
    return 1;
  }

  if (!StartCubism()) {
    ReleaseGraphics();
    return 1;
  }

  NativeModel model;
  if (!model_json.empty() && !model.Load(model_json, width, height)) {
    StopCubism();
    ReleaseGraphics();
    return 1;
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

  StopCubism();
  DestroyWindow(window);
  UnregisterClassW(kWindowClassName, instance);
  ReleaseGraphics();
  return 0;
}

}  // namespace

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE, PWSTR, int) {
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
  return Run(instance, model_json);
}
