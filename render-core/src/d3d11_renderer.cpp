#include "ag99/live2d/d3d11_renderer.hpp"

#include <CubismModelSettingJson.hpp>
#include <Model/CubismUserModel.hpp>
#include <Rendering/D3D11/CubismDeviceInfo_D3D11.hpp>
#include <Rendering/D3D11/CubismRenderer_D3D11.hpp>
#include <WICTextureLoader.h>

#include <iostream>
#include <vector>

namespace {

using namespace Live2D::Cubism::Framework;

struct TextureResource {
  ID3D11Resource* resource = nullptr;
  ID3D11ShaderResourceView* view = nullptr;
};

}  // namespace

namespace ag99::live2d {

struct D3D11Renderer::Impl {
  CubismUserModel* model = nullptr;
  ID3D11DeviceContext* context = nullptr;
  UINT width = 0;
  UINT height = 0;
  bool renderer_created = false;
  std::vector<TextureResource> textures;

  void Shutdown() {
    if (model && renderer_created) {
      model->DeleteRenderer();
    }
    renderer_created = false;
    model = nullptr;

    for (auto& texture : textures) {
      if (texture.view) {
        texture.view->Release();
      }
      if (texture.resource) {
        texture.resource->Release();
      }
    }
    textures.clear();
    context = nullptr;
    width = 0;
    height = 0;
  }
};

D3D11Renderer::D3D11Renderer() : _impl(std::make_unique<Impl>()) {}

D3D11Renderer::~D3D11Renderer() {
  Shutdown();
}

void D3D11Renderer::ConfigureDevice(ID3D11Device* device) {
  Rendering::CubismRenderer_D3D11::SetConstantSettings(2, device);
}

void D3D11Renderer::ReleaseDeviceResources() {
  Rendering::CubismDeviceInfo_D3D11::ReleaseAllDeviceInfo();
}

bool D3D11Renderer::Initialize(
    CubismUserModel& model,
    CubismModelSettingJson& setting,
    ID3D11Device* device,
    ID3D11DeviceContext* context,
    const std::filesystem::path& model_directory,
    UINT width,
    UINT height) {
  Shutdown();
  if (!model.GetModel() || !device || !context || width == 0 || height == 0) {
    std::cerr << "Cubism D3D11 renderer requires a loaded model, device, "
                 "context, and non-zero target size\n";
    return false;
  }

  _impl->model = &model;
  _impl->context = context;
  _impl->width = width;
  _impl->height = height;
  model.CreateRenderer(width, height);
  _impl->renderer_created = true;

  auto* renderer = model.GetRenderer<Rendering::CubismRenderer_D3D11>();
  if (!renderer) {
    std::cerr << "Cubism D3D11 renderer creation failed\n";
    Shutdown();
    return false;
  }

  for (csmInt32 index = 0; index < setting.GetTextureCount(); ++index) {
    const char* texture_name = setting.GetTextureFileName(index);
    if (!texture_name || texture_name[0] == '\0') {
      continue;
    }

    const auto texture_path = model_directory / texture_name;
    TextureResource texture;
    const HRESULT result = DirectX::CreateWICTextureFromFile(
        device, context, texture_path.wstring().c_str(),
        &texture.resource, &texture.view);
    if (FAILED(result)) {
      if (texture.view) {
        texture.view->Release();
      }
      if (texture.resource) {
        texture.resource->Release();
      }
      std::cerr << "Failed to load texture: " << texture_path.string()
                << " (0x" << std::hex
                << static_cast<unsigned long>(result) << std::dec << ")\n";
      Shutdown();
      return false;
    }

    renderer->BindTexture(static_cast<csmUint32>(index), texture.view);
    _impl->textures.push_back(texture);
  }

  renderer->IsPremultipliedAlpha(false);
  return true;
}

void D3D11Renderer::Draw() {
  if (!_impl->model || !_impl->context || !_impl->model->GetModel()) {
    return;
  }

  auto* renderer =
      _impl->model->GetRenderer<Rendering::CubismRenderer_D3D11>();
  if (!renderer) {
    return;
  }

  const auto* model = _impl->model->GetModel();
  renderer->StartFrame(_impl->context);

  CubismMatrix44 matrix;
  matrix.LoadIdentity();
  if (_impl->width > 0 && _impl->height > 0) {
    if (model->GetCanvasWidth() > 1.0f && _impl->width < _impl->height) {
      matrix.Scale(
          1.0f,
          static_cast<csmFloat32>(_impl->width)
              / static_cast<csmFloat32>(_impl->height));
    } else {
      matrix.Scale(
          static_cast<csmFloat32>(_impl->height)
              / static_cast<csmFloat32>(_impl->width),
          1.0f);
    }
  }
  matrix.MultiplyByMatrix(_impl->model->GetModelMatrix());
  renderer->SetMvpMatrix(&matrix);
  renderer->DrawModel();
  renderer->EndFrame();
}

void D3D11Renderer::Shutdown() {
  if (_impl) {
    _impl->Shutdown();
  }
}

}  // namespace ag99::live2d
