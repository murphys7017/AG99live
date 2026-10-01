#pragma once

#include <d3d11.h>
#include <windows.h>

#include <memory>

namespace ag99::live2d {

class D3D11CompositionSurface final {
public:
  // All methods must be called on the thread that initializes the surface.
  D3D11CompositionSurface();
  ~D3D11CompositionSurface();

  D3D11CompositionSurface(const D3D11CompositionSurface&) = delete;
  D3D11CompositionSurface& operator=(const D3D11CompositionSurface&) = delete;

  HRESULT Initialize(HWND window, UINT width, UINT height);
  HRESULT BeginFrame() noexcept;
  HRESULT Present(UINT sync_interval = 1, UINT flags = 0) noexcept;
  void Shutdown() noexcept;

  // Returned interfaces are borrowed and remain valid until Shutdown().
  ID3D11Device* Device() const noexcept;
  ID3D11DeviceContext* Context() const noexcept;

private:
  struct Impl;
  std::unique_ptr<Impl> _impl;
};

}  // namespace ag99::live2d
