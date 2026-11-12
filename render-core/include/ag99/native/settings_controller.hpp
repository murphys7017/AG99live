#pragma once

#include <optional>
#include <string>

#include "ag99/runtime/protocol.hpp"

namespace ag99::native {

struct SettingsSnapshot {
  bool ambient_motion_enabled = true;
  bool cursor_gaze_enabled = true;
  double cursor_gaze_poll_interval_ms = 100.0;
  double cursor_gaze_dwell_ms = 450.0;
  double cursor_gaze_stationary_distance_px = 14.0;
  double speech_volume = 1.0;
  double physics_response_scale = 1.0;
  double model_view_scale = 1.0;
  double model_view_offset_x = 0.0;
  double model_view_offset_y = 0.0;
  double motion_intensity_scale = 1.35;
};

class SettingsController final {
 public:
  SettingsController() = default;

  ag99::runtime::DesktopSettingsResult HandleQuery(
      const ag99::runtime::DesktopSettingsQuery& query);

  const SettingsSnapshot& Snapshot() const noexcept { return snapshot_; }

 private:
  static std::optional<double> ParseNumber(const std::string& value);
  static ag99::runtime::DesktopSettingsEntry NumberEntry(
      double value,
      double minimum,
      double maximum,
      double step);

  SettingsSnapshot snapshot_;
};

}  // namespace ag99::native
