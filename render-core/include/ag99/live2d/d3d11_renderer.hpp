#pragma once

#include <d3d11.h>

#include <filesystem>
#include <memory>

namespace Live2D::Cubism::Framework {
class CubismModelSettingJson;
class CubismUserModel;
}

namespace ag99::live2d {

class D3D11Renderer final {
public:
  D3D11Renderer();
  ~D3D11Renderer();

  D3D11Renderer(const D3D11Renderer&) = delete;
  D3D11Renderer& operator=(const D3D11Renderer&) = delete;

  static void ConfigureDevice(ID3D11Device* device);
  static void ReleaseDeviceResources();

  // Use on the surface's render thread. The device and context are borrowed
  // and must outlive this renderer.
  // ReleaseDeviceResources must run after all renderers are shut down and
  // before CubismFramework::CleanUp releases Cubism's allocator.
  bool Initialize(
      Live2D::Cubism::Framework::CubismUserModel& model,
      Live2D::Cubism::Framework::CubismModelSettingJson& setting,
      ID3D11Device* device,
      ID3D11DeviceContext* context,
      const std::filesystem::path& model_directory,
      UINT width,
      UINT height);
  void Draw();
  void Shutdown();

private:
  struct Impl;
  std::unique_ptr<Impl> _impl;
};

}  // namespace ag99::live2d
