#include <cassert>
#include <optional>
#include <string>
#include <utility>

#include "ag99/native/settings_controller.hpp"
#include "ag99/native/spout_output.hpp"

namespace {

ag99::runtime::DesktopSettingsQuery Query(
    std::string key,
    std::string action,
    std::string value = {}) {
  return ag99::runtime::DesktopSettingsQuery{
      ag99::runtime::ProtocolEnvelope{},
      "settings-smoke",
      std::move(key),
      std::move(action),
      value.empty() ? std::nullopt : std::optional<std::string>(std::move(value)),
  };
}

void AssertValue(
    const ag99::runtime::DesktopSettingsResult& result,
    const char* expected) {
  assert(result.entry.has_value());
  assert(result.entry->value == expected);
  assert(result.error.empty());
}

}  // namespace

int main() {
  ag99::native::SettingsController settings;

  AssertValue(
      settings.HandleQuery(Query("live2d_ambient_motion_enabled", "list")),
      "true");
  AssertValue(
      settings.HandleQuery(Query("model_view_scale", "list")),
      "1");
  AssertValue(
      settings.HandleQuery(Query(
          "model_view_offset_x", "set", "1.25")),
      "1.25");
  AssertValue(
      settings.HandleQuery(Query(
          "motion_engine_intensity_scale", "set", "2.0")),
      "2");
  AssertValue(
      settings.HandleQuery(Query("speech_volume", "list")),
      "1");
  AssertValue(
      settings.HandleQuery(Query("speech_volume", "set", "0.55")),
      "0.55");
  const auto volume_invalid = settings.HandleQuery(Query(
      "speech_volume", "set", "1.1"));
  assert(!volume_invalid.entry.has_value());
  assert(volume_invalid.error == "desktop_setting_value_out_of_range");
  AssertValue(
      settings.HandleQuery(Query("cursor_gaze_enabled", "list")),
      "true");
  AssertValue(
      settings.HandleQuery(Query(
          "cursor_gaze_dwell_ms", "set", "700")),
      "700");
  const auto gaze_invalid = settings.HandleQuery(Query(
      "cursor_gaze_poll_interval_ms", "set", "10"));
  assert(!gaze_invalid.entry.has_value());
  assert(gaze_invalid.error == "desktop_setting_value_out_of_range");

  const auto invalid = settings.HandleQuery(Query(
      "model_view_scale", "set", "9"));
  assert(!invalid.entry.has_value());
  assert(invalid.error == "desktop_setting_value_out_of_range");

  const auto unsupported = settings.HandleQuery(Query(
      "spout_enabled", "list"));
  assert(!unsupported.entry.has_value());
  assert(unsupported.error == "desktop_setting_unsupported");

  ag99::native::SpoutOutput spout(
      "C:/ag99live-missing/AG99liveSpoutSender.exe");
  AssertValue(
      spout.HandleSetting(Query("spout_enabled", "list")),
      "false");
  const auto spout_failed = spout.HandleSetting(Query(
      "spout_enabled", "set", "true"));
  assert(!spout_failed.entry.has_value());
  assert(spout_failed.error == "desktop_setting_failed");
  return 0;
}
