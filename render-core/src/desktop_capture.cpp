#include "ag99/native/desktop_capture.hpp"

#include <windows.h>
#include <wincodec.h>
#include <wrl/client.h>

#include <algorithm>
#include <cstdint>
#include <span>
#include <string_view>
#include <vector>

namespace ag99::native {
namespace {

using Microsoft::WRL::ComPtr;

std::string Base64(std::span<const std::uint8_t> bytes) {
  constexpr char alphabet[] =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string output;
  output.reserve((bytes.size() + 2) / 3 * 4);
  for (std::size_t index = 0; index < bytes.size(); index += 3) {
    const auto remaining = bytes.size() - index;
    const std::uint32_t value =
        (static_cast<std::uint32_t>(bytes[index]) << 16)
        | (remaining > 1
               ? static_cast<std::uint32_t>(bytes[index + 1]) << 8 : 0)
        | (remaining > 2 ? bytes[index + 2] : 0);
    output.push_back(alphabet[(value >> 18) & 0x3f]);
    output.push_back(alphabet[(value >> 12) & 0x3f]);
    output.push_back(remaining > 1 ? alphabet[(value >> 6) & 0x3f] : '=');
    output.push_back(remaining > 2 ? alphabet[value & 0x3f] : '=');
  }
  return output;
}

bool SetError(std::string& error, std::string_view value) {
  error = std::string(value);
  return false;
}

}  // namespace

std::optional<std::string> CaptureDesktopJpeg(std::string& error) {
  const int left = GetSystemMetrics(SM_XVIRTUALSCREEN);
  const int top = GetSystemMetrics(SM_YVIRTUALSCREEN);
  const int width = GetSystemMetrics(SM_CXVIRTUALSCREEN);
  const int height = GetSystemMetrics(SM_CYVIRTUALSCREEN);
  if (width <= 0 || height <= 0) {
    SetError(error, "desktop_capture_screen_bounds_invalid");
    return std::nullopt;
  }

  HDC screen = GetDC(nullptr);
  HDC memory = screen ? CreateCompatibleDC(screen) : nullptr;
  HBITMAP bitmap = screen ? CreateCompatibleBitmap(screen, width, height) : nullptr;
  if (!screen || !memory || !bitmap) {
    if (bitmap) DeleteObject(bitmap);
    if (memory) DeleteDC(memory);
    if (screen) ReleaseDC(nullptr, screen);
    SetError(error, "desktop_capture_bitmap_create_failed");
    return std::nullopt;
  }
  const auto previous = SelectObject(memory, bitmap);
  const bool copied = BitBlt(
      memory, 0, 0, width, height, screen, left, top,
      SRCCOPY | CAPTUREBLT) != FALSE;
  SelectObject(memory, previous);
  DeleteDC(memory);
  ReleaseDC(nullptr, screen);
  if (!copied) {
    DeleteObject(bitmap);
    SetError(error, "desktop_capture_bitblt_failed");
    return std::nullopt;
  }

  HRESULT com_result = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  const bool com_initialized = SUCCEEDED(com_result);
  if (FAILED(com_result) && com_result != RPC_E_CHANGED_MODE) {
    DeleteObject(bitmap);
    SetError(error, "desktop_capture_com_init_failed");
    return std::nullopt;
  }

  ComPtr<IWICImagingFactory> factory;
  HRESULT result = CoCreateInstance(
      CLSID_WICImagingFactory2, nullptr, CLSCTX_INPROC_SERVER,
      IID_PPV_ARGS(factory.GetAddressOf()));
  if (FAILED(result)) {
    result = CoCreateInstance(
        CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER,
        IID_PPV_ARGS(factory.GetAddressOf()));
  }
  ComPtr<IWICBitmap> source_bitmap;
  if (SUCCEEDED(result)) {
    result = factory->CreateBitmapFromHBITMAP(
        bitmap, nullptr, WICBitmapUseAlpha, source_bitmap.GetAddressOf());
  }
  DeleteObject(bitmap);
  if (FAILED(result)) {
    if (com_initialized) CoUninitialize();
    SetError(error, "desktop_capture_wic_bitmap_failed");
    return std::nullopt;
  }

  ComPtr<IWICBitmapSource> source = source_bitmap;
  const UINT max_width = 1600;
  const UINT max_height = 900;
  if (width > static_cast<int>(max_width)
      || height > static_cast<int>(max_height)) {
    const double scale = std::min(
        static_cast<double>(max_width) / width,
        static_cast<double>(max_height) / height);
    const auto scaled_width = std::max<UINT>(1, static_cast<UINT>(width * scale));
    const auto scaled_height = std::max<UINT>(1, static_cast<UINT>(height * scale));
    ComPtr<IWICBitmapScaler> scaler;
    result = factory->CreateBitmapScaler(scaler.GetAddressOf());
    if (SUCCEEDED(result)) {
      result = scaler->Initialize(
          source.Get(), scaled_width, scaled_height,
          WICBitmapInterpolationModeFant);
    }
    if (FAILED(result)) {
      if (com_initialized) CoUninitialize();
      SetError(error, "desktop_capture_scale_failed");
      return std::nullopt;
    }
    source = scaler;
  }

  ComPtr<IStream> stream;
  result = CreateStreamOnHGlobal(nullptr, TRUE, stream.GetAddressOf());
  ComPtr<IWICBitmapEncoder> encoder;
  ComPtr<IWICBitmapFrameEncode> frame;
  if (SUCCEEDED(result)) {
    result = factory->CreateEncoder(
        GUID_ContainerFormatJpeg, nullptr, encoder.GetAddressOf());
  }
  if (SUCCEEDED(result)) {
    result = encoder->Initialize(stream.Get(), WICBitmapEncoderNoCache);
  }
  if (SUCCEEDED(result)) {
    result = encoder->CreateNewFrame(
        frame.GetAddressOf(), nullptr);
  }
  if (SUCCEEDED(result)) {
    result = frame->Initialize(nullptr);
  }
  if (SUCCEEDED(result)) {
    result = frame->WriteSource(source.Get(), nullptr);
  }
  if (SUCCEEDED(result)) {
    result = frame->Commit();
  }
  if (SUCCEEDED(result)) {
    result = encoder->Commit();
  }
  if (FAILED(result)) {
    if (com_initialized) CoUninitialize();
    SetError(error, "desktop_capture_jpeg_encode_failed");
    return std::nullopt;
  }

  HGLOBAL global = nullptr;
  result = GetHGlobalFromStream(stream.Get(), &global);
  SIZE_T size = SUCCEEDED(result) ? GlobalSize(global) : 0;
  void* data = size > 0 ? GlobalLock(global) : nullptr;
  std::optional<std::string> output;
  if (data && size > 0) {
    const auto* bytes = static_cast<const std::uint8_t*>(data);
    output = Base64(std::span<const std::uint8_t>(bytes, size));
    if (output->size() > 1'000'000) {
      output.reset();
      error = "desktop_capture_frame_too_large";
    }
    GlobalUnlock(global);
  }
  if (com_initialized) CoUninitialize();
  if (!output && error.empty()) {
    error = "desktop_capture_stream_read_failed";
  }
  return output;
}

}  // namespace ag99::native
