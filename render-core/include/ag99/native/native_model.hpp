#pragma once

#include <d3d11.h>

#include <atomic>
#include <filesystem>
#include <functional>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "ag99/native/audio_runtime.hpp"
#include "ag99/native/runtime_coordinator.hpp"

namespace ag99::native {

struct NativeModelServices {
  std::function<double()> now_seconds;
  std::function<std::optional<std::filesystem::path>(std::string_view)>
      path_from_utf8;
  std::function<std::string(const std::filesystem::path&)> path_to_utf8;
  std::function<bool(
      const std::filesystem::path&, std::vector<std::uint8_t>&)> read_file;
  AudioRuntime* audio_runtime = nullptr;
  std::atomic<float>* drag_x = nullptr;
  std::atomic<float>* drag_y = nullptr;
};

class NativeModel final {
public:
  explicit NativeModel(NativeModelServices services);
  ~NativeModel();

  NativeModel(const NativeModel&) = delete;
  NativeModel& operator=(const NativeModel&) = delete;

  bool Load(
      const std::filesystem::path& model_json,
      UINT width,
      UINT height,
      ID3D11Device* device,
      ID3D11DeviceContext* context);
  void UpdateAndDraw();
  void UpdateCursorGaze(HWND window);
  void QueueOutputSegment(
      ag99::runtime::OutputSegment segment,
      std::optional<NativeSegmentClock> clock = std::nullopt);
  std::vector<NativeSegmentTerminal> TakeMotionTerminals();
  void ResetRuntimeSegments(std::uint64_t generation);
  void StartThinkingSway(const std::string& turn_id);
  void ReleaseThinkingSway(const std::string& turn_id);
  void CancelTurn(const std::string& turn_id);
  void SetModelSync(const ag99::runtime::Json& payload);
  ag99::runtime::DesktopSettingsResult HandleDesktopSettingsQuery(
      const ag99::runtime::DesktopSettingsQuery& query);

private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace ag99::native
