#include <cassert>
#include <optional>
#include <string>
#include <utility>

#include "ag99/native/settings_controller.hpp"

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

  const auto invalid = settings.HandleQuery(Query(
      "model_view_scale", "set", "9"));
  assert(!invalid.entry.has_value());
  assert(invalid.error == "desktop_setting_value_out_of_range");

  const auto unsupported = settings.HandleQuery(Query(
      "spout_enabled", "list"));
  assert(!unsupported.entry.has_value());
  assert(unsupported.error == "desktop_setting_unsupported");
  return 0;
}
