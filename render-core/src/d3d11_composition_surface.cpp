#include "ag99/live2d/d3d11_composition_surface.hpp"

#include <dcomp.h>
#include <dxgi1_3.h>
#include <wrl/client.h>

#include <iostream>
#include <vector>

namespace ag99::live2d {

using Microsoft::WRL::ComPtr;

struct D3D11CompositionSurface::Impl {
  ComPtr<ID3D11Device> device;
  ComPtr<ID3D11DeviceContext> context;
  ComPtr<IDXGISwapChain1> swap_chain;
  ComPtr<ID3D11RenderTargetView> render_target;
  ComPtr<ID3D11Texture2D> staging_texture;
  UINT width = 0;
  UINT height = 0;
  ComPtr<IDCompositionDevice> composition_device;
  ComPtr<IDCompositionTarget> composition_target;
  ComPtr<IDCompositionVisual> composition_visual;

  HRESULT CreateRenderTarget() {
    ComPtr<ID3D11Texture2D> back_buffer;
    HRESULT result = swap_chain->GetBuffer(
        0, IID_PPV_ARGS(back_buffer.GetAddressOf()));
    if (FAILED(result)) {
      return result;
    }
    return device->CreateRenderTargetView(
        back_buffer.Get(), nullptr, render_target.GetAddressOf());
  }
};

D3D11CompositionSurface::D3D11CompositionSurface()
    : _impl(std::make_unique<Impl>()) {}

D3D11CompositionSurface::~D3D11CompositionSurface() {
  Shutdown();
}

HRESULT D3D11CompositionSurface::Initialize(
    HWND window,
    UINT width,
    UINT height) {
  Shutdown();
  if (!window || width == 0 || height == 0) {
    return E_INVALIDARG;
  }

  const auto fail = [this](const char* operation, HRESULT result) {
    std::cerr << operation << " failed: 0x" << std::hex
              << static_cast<unsigned long>(result) << std::dec << '\n';
    Shutdown();
    return result;
  };

  D3D_FEATURE_LEVEL feature_level{};
  constexpr UINT device_flags =
      D3D11_CREATE_DEVICE_SINGLETHREADED | D3D11_CREATE_DEVICE_BGRA_SUPPORT;
  HRESULT result = D3D11CreateDevice(
      nullptr,
      D3D_DRIVER_TYPE_HARDWARE,
      nullptr,
      device_flags,
      nullptr,
      0,
      D3D11_SDK_VERSION,
      _impl->device.GetAddressOf(),
      &feature_level,
      _impl->context.GetAddressOf());
  if (FAILED(result)) {
    return fail("D3D11CreateDevice", result);
  }

  ComPtr<IDXGIDevice> dxgi_device;
  result = _impl->device.As(&dxgi_device);
  if (FAILED(result)) {
    return fail("Query IDXGIDevice", result);
  }

  ComPtr<IDXGIFactory2> factory;
  result = CreateDXGIFactory2(0, IID_PPV_ARGS(factory.GetAddressOf()));
  if (FAILED(result)) {
    return fail("CreateDXGIFactory2", result);
  }

  DXGI_SWAP_CHAIN_DESC1 description{};
  description.Width = width;
  description.Height = height;
  description.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
  description.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
  description.BufferCount = 2;
  description.SampleDesc.Count = 1;
  description.Scaling = DXGI_SCALING_STRETCH;
  description.SwapEffect = DXGI_SWAP_EFFECT_FLIP_SEQUENTIAL;
  description.AlphaMode = DXGI_ALPHA_MODE_PREMULTIPLIED;
  result = factory->CreateSwapChainForComposition(
      _impl->device.Get(),
      &description,
      nullptr,
      _impl->swap_chain.GetAddressOf());
  if (FAILED(result)) {
    return fail("CreateSwapChainForComposition", result);
  }

  result = DCompositionCreateDevice(
      dxgi_device.Get(),
      __uuidof(IDCompositionDevice),
      reinterpret_cast<void**>(_impl->composition_device.GetAddressOf()));
  if (FAILED(result)) {
    return fail("DCompositionCreateDevice", result);
  }

  result = _impl->composition_device->CreateTargetForHwnd(
      window, TRUE, _impl->composition_target.GetAddressOf());
  if (FAILED(result)) {
    return fail("CreateTargetForHwnd", result);
  }

  result = _impl->composition_device->CreateVisual(
      _impl->composition_visual.GetAddressOf());
  if (FAILED(result)) {
    return fail("CreateVisual", result);
  }

  result = _impl->composition_visual->SetContent(_impl->swap_chain.Get());
  if (FAILED(result)) {
    return fail("SetContent", result);
  }

  result = _impl->composition_target->SetRoot(
      _impl->composition_visual.Get());
  if (FAILED(result)) {
    return fail("SetRoot", result);
  }

  result = _impl->composition_device->Commit();
  if (FAILED(result)) {
    return fail("DirectComposition Commit", result);
  }

  result = _impl->CreateRenderTarget();
  if (FAILED(result)) {
    return fail("CreateRenderTargetView", result);
  }
  _impl->width = width;
  _impl->height = height;
  return S_OK;
}

HRESULT D3D11CompositionSurface::BeginFrame() noexcept {
  if (!_impl->context || !_impl->render_target) {
    return E_UNEXPECTED;
  }

  ID3D11RenderTargetView* target = _impl->render_target.Get();
  _impl->context->OMSetRenderTargets(1, &target, nullptr);
  constexpr FLOAT transparent_black[4] = {0.0f, 0.0f, 0.0f, 0.0f};
  _impl->context->ClearRenderTargetView(target, transparent_black);
  return S_OK;
}

HRESULT D3D11CompositionSurface::Resize(UINT width, UINT height) noexcept {
  if (!_impl->swap_chain || !_impl->context || width == 0 || height == 0) {
    return E_INVALIDARG;
  }
  if (_impl->width == width && _impl->height == height) {
    return S_OK;
  }
  _impl->context->OMSetRenderTargets(0, nullptr, nullptr);
  _impl->render_target.Reset();
  _impl->staging_texture.Reset();
  const HRESULT result = _impl->swap_chain->ResizeBuffers(
      0, width, height, DXGI_FORMAT_UNKNOWN, 0);
  if (FAILED(result)) {
    return result;
  }
  const HRESULT target_result = _impl->CreateRenderTarget();
  if (FAILED(target_result)) {
    return target_result;
  }
  _impl->width = width;
  _impl->height = height;
  if (_impl->composition_device) {
    return _impl->composition_device->Commit();
  }
  return S_OK;
}

HRESULT D3D11CompositionSurface::Present(
    UINT sync_interval,
    UINT flags) noexcept {
  if (!_impl->swap_chain) {
    return E_UNEXPECTED;
  }
  return _impl->swap_chain->Present(sync_interval, flags);
}

HRESULT D3D11CompositionSurface::ReadbackRgba(
    std::vector<std::uint8_t>& output) noexcept {
  if (!_impl->device || !_impl->context || !_impl->swap_chain
      || !_impl->width || !_impl->height) {
    return E_UNEXPECTED;
  }
  ComPtr<ID3D11Texture2D> source;
  HRESULT result = _impl->swap_chain->GetBuffer(
      0, IID_PPV_ARGS(source.GetAddressOf()));
  if (FAILED(result)) {
    return result;
  }
  D3D11_TEXTURE2D_DESC description{};
  source->GetDesc(&description);
  if (!_impl->staging_texture) {
    description.Usage = D3D11_USAGE_STAGING;
    description.BindFlags = 0;
    description.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    description.MiscFlags = 0;
    result = _impl->device->CreateTexture2D(
        &description, nullptr, _impl->staging_texture.GetAddressOf());
    if (FAILED(result)) {
      return result;
    }
  }
  _impl->context->CopyResource(_impl->staging_texture.Get(), source.Get());
  D3D11_MAPPED_SUBRESOURCE mapped{};
  result = _impl->context->Map(
      _impl->staging_texture.Get(), 0, D3D11_MAP_READ, 0, &mapped);
  if (FAILED(result)) {
    return result;
  }
  output.resize(static_cast<std::size_t>(_impl->width) * _impl->height * 4);
  for (UINT row = 0; row < _impl->height; ++row) {
    const auto* source_row = static_cast<const std::uint8_t*>(mapped.pData)
        + static_cast<std::size_t>(row) * mapped.RowPitch;
    auto* target_row = output.data()
        + static_cast<std::size_t>(row) * _impl->width * 4;
    for (UINT column = 0; column < _impl->width; ++column) {
      const auto* pixel = source_row + static_cast<std::size_t>(column) * 4;
      auto* target = target_row + static_cast<std::size_t>(column) * 4;
      target[0] = pixel[2];
      target[1] = pixel[1];
      target[2] = pixel[0];
      target[3] = pixel[3];
    }
  }
  _impl->context->Unmap(_impl->staging_texture.Get(), 0);
  return S_OK;
}

void D3D11CompositionSurface::Shutdown() noexcept {
  if (!_impl) {
    return;
  }
  if (_impl->context) {
    _impl->context->ClearState();
    _impl->context->Flush();
  }
  _impl->render_target.Reset();
  _impl->staging_texture.Reset();
  if (_impl->composition_visual) {
    const HRESULT result = _impl->composition_visual->SetContent(nullptr);
    if (FAILED(result)) {
      std::cerr << "DirectComposition SetContent(nullptr) failed: 0x"
                << std::hex << static_cast<unsigned long>(result) << std::dec
                << '\n';
    }
  }
  if (_impl->composition_target) {
    const HRESULT result = _impl->composition_target->SetRoot(nullptr);
    if (FAILED(result)) {
      std::cerr << "DirectComposition SetRoot(nullptr) failed: 0x"
                << std::hex << static_cast<unsigned long>(result) << std::dec
                << '\n';
    }
  }
  if (_impl->composition_device) {
    const HRESULT result = _impl->composition_device->Commit();
    if (FAILED(result)) {
      std::cerr << "DirectComposition detach Commit failed: 0x"
                << std::hex << static_cast<unsigned long>(result) << std::dec
                << '\n';
    }
  }
  _impl->composition_visual.Reset();
  _impl->composition_target.Reset();
  _impl->composition_device.Reset();
  _impl->swap_chain.Reset();
  _impl->context.Reset();
  _impl->device.Reset();
  _impl->width = 0;
  _impl->height = 0;
}

ID3D11Device* D3D11CompositionSurface::Device() const noexcept {
  return _impl ? _impl->device.Get() : nullptr;
}

ID3D11DeviceContext* D3D11CompositionSurface::Context() const noexcept {
  return _impl ? _impl->context.Get() : nullptr;
}

}  // namespace ag99::live2d
