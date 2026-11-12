#include "ag99/native/settings_controller.hpp"

#include <windows.h>

#include <array>
#include <charconv>
#include <cmath>
#include <cstdlib>
#include <string_view>

namespace ag99::native {
namespace {

std::wstring WidenUtf8(std::string_view value) {
  if (value.empty()) {
    return {};
  }
  const int length = MultiByteToWideChar(
      CP_UTF8,
      MB_ERR_INVALID_CHARS,
      value.data(),
      static_cast<int>(value.size()),
      nullptr,
      0);
  if (length <= 0) {
    return {};
  }
  std::wstring result(static_cast<std::size_t>(length), L'\0');
  MultiByteToWideChar(
      CP_UTF8,
      MB_ERR_INVALID_CHARS,
      value.data(),
      static_cast<int>(value.size()),
      result.data(),
      length);
  return result;
}

constexpr std::wstring_view kJavascriptWhitespace =
    L"\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004"
    L"\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f"
    L"\u205f\u3000\ufeff";

}  // namespace

std::optional<double> SettingsController::ParseNumber(
    const std::string& input) {
  const auto wide = WidenUtf8(input);
  const auto first = wide.find_first_not_of(kJavascriptWhitespace);
  if (first == std::wstring::npos) {
    return std::nullopt;
  }
  const auto last = wide.find_last_not_of(kJavascriptWhitespace);
  std::string value;
  value.reserve(last - first + 1);
  for (auto index = first; index <= last; ++index) {
    if (wide[index] > 0x7f) {
      return std::nullopt;
    }
    value.push_back(static_cast<char>(wide[index]));
  }

  int radix = 0;
  if (value.size() > 2 && value[0] == '0') {
    if (value[1] == 'x' || value[1] == 'X') radix = 16;
    if (value[1] == 'o' || value[1] == 'O') radix = 8;
    if (value[1] == 'b' || value[1] == 'B') radix = 2;
  }
  if (radix != 0) {
    double number = 0.0;
    for (std::size_t index = 2; index < value.size(); ++index) {
      const auto character = value[index];
      const int digit = character >= '0' && character <= '9'
          ? character - '0'
          : character >= 'a' && character <= 'f'
              ? character - 'a' + 10
              : character >= 'A' && character <= 'F'
                  ? character - 'A' + 10 : -1;
      if (digit < 0 || digit >= radix) {
        return std::nullopt;
      }
      number = number * radix + digit;
    }
    return std::isfinite(number)
        ? std::optional<double>(number) : std::nullopt;
  }
  if (value.find_first_of("xXpP") != std::string::npos) {
    return std::nullopt;
  }
  char* end = nullptr;
  const auto number = std::strtod(value.c_str(), &end);
  if (end != value.c_str() + value.size() || !std::isfinite(number)) {
    return std::nullopt;
  }
  return number;
}

ag99::runtime::DesktopSettingsEntry SettingsController::NumberEntry(
    double value,
    double minimum,
    double maximum,
    double step) {
  std::array<char, 32> value_text{};
  const auto formatted = std::to_chars(
      value_text.data(), value_text.data() + value_text.size(), value);
  return ag99::runtime::DesktopSettingsEntry{
      std::string(value_text.data(), formatted.ptr),
      {},
      minimum,
      maximum,
      step};
}

ag99::runtime::DesktopSettingsResult SettingsController::HandleQuery(
    const ag99::runtime::DesktopSettingsQuery& query) {
  ag99::runtime::DesktopSettingsResult result{
      query.request_id,
      query.key,
      std::nullopt,
      {}};

  if (query.key == "live2d_ambient_motion_enabled") {
    if (query.action == "set") {
      const auto value = query.value.value_or("");
      if (value != "true" && value != "false") {
        result.error = "desktop_setting_value_invalid";
        return result;
      }
      snapshot_.ambient_motion_enabled = value == "true";
    }
    result.entry = ag99::runtime::DesktopSettingsEntry{
        snapshot_.ambient_motion_enabled ? "true" : "false",
        {},
        std::nullopt,
        std::nullopt,
        std::nullopt};
    return result;
  }

  if (query.key == "speech_volume") {
    if (query.action == "set") {
      const auto parsed = ParseNumber(query.value.value_or(""));
      if (!parsed) {
        result.error = "desktop_setting_value_invalid";
        return result;
      }
      if (*parsed < 0.0 || *parsed > 1.0) {
        result.error = "desktop_setting_value_out_of_range";
        return result;
      }
      snapshot_.speech_volume = std::round(*parsed * 100.0) / 100.0;
    }
    result.entry = NumberEntry(snapshot_.speech_volume, 0.0, 1.0, 0.01);
    return result;
  }

  if (query.key == "cursor_gaze_enabled") {
    if (query.action == "set") {
      const auto value = query.value.value_or("");
      if (value != "true" && value != "false") {
        result.error = "desktop_setting_value_invalid";
        return result;
      }
      snapshot_.cursor_gaze_enabled = value == "true";
    }
    result.entry = ag99::runtime::DesktopSettingsEntry{
        snapshot_.cursor_gaze_enabled ? "true" : "false",
        {},
        std::nullopt,
        std::nullopt,
        std::nullopt};
    return result;
  }

  if (query.key == "cursor_gaze_poll_interval_ms"
      || query.key == "cursor_gaze_dwell_ms"
      || query.key == "cursor_gaze_stationary_distance_px") {
    double* target = nullptr;
    double minimum = 0.0;
    double maximum = 0.0;
    double step = 1.0;
    if (query.key == "cursor_gaze_poll_interval_ms") {
      target = &snapshot_.cursor_gaze_poll_interval_ms;
      minimum = 50.0;
      maximum = 1000.0;
      step = 10.0;
    } else if (query.key == "cursor_gaze_dwell_ms") {
      target = &snapshot_.cursor_gaze_dwell_ms;
      minimum = 100.0;
      maximum = 2000.0;
      step = 50.0;
    } else {
      target = &snapshot_.cursor_gaze_stationary_distance_px;
      minimum = 1.0;
      maximum = 100.0;
    }
    if (query.action == "set") {
      const auto parsed = ParseNumber(query.value.value_or(""));
      if (!parsed) {
        result.error = "desktop_setting_value_invalid";
        return result;
      }
      if (*parsed < minimum || *parsed > maximum) {
        result.error = "desktop_setting_value_out_of_range";
        return result;
      }
      *target = std::round(*parsed);
    }
    result.entry = NumberEntry(*target, minimum, maximum, step);
    return result;
  }

  if (query.key == "model_view_scale"
      || query.key == "model_view_offset_x"
      || query.key == "model_view_offset_y") {
    double* target = nullptr;
    double minimum = 0.0;
    double maximum = 0.0;
    if (query.key == "model_view_scale") {
      target = &snapshot_.model_view_scale;
      minimum = 0.8;
      maximum = 2.0;
    } else if (query.key == "model_view_offset_x") {
      target = &snapshot_.model_view_offset_x;
      minimum = -1.5;
      maximum = 1.5;
    } else {
      target = &snapshot_.model_view_offset_y;
      minimum = -1.5;
      maximum = 1.5;
    }
    if (query.action == "set") {
      const auto parsed = ParseNumber(query.value.value_or(""));
      if (!parsed) {
        result.error = "desktop_setting_value_invalid";
        return result;
      }
      if (*parsed < minimum || *parsed > maximum) {
        result.error = "desktop_setting_value_out_of_range";
        return result;
      }
      *target = *parsed;
    }
    result.entry = NumberEntry(*target, minimum, maximum, 0.05);
    return result;
  }

  if (query.key == "motion_engine_intensity_scale") {
    if (query.action == "set") {
      const auto parsed = ParseNumber(query.value.value_or(""));
      if (!parsed) {
        result.error = "desktop_setting_value_invalid";
        return result;
      }
      if (*parsed < 0.5 || *parsed > 2.5) {
        result.error = "desktop_setting_value_out_of_range";
        return result;
      }
      snapshot_.motion_intensity_scale =
          std::round(*parsed * 100.0) / 100.0;
    }
    result.entry = NumberEntry(
        snapshot_.motion_intensity_scale, 0.5, 2.5, 0.05);
    return result;
  }

  if (query.key == "live2d_physics_response_scale") {
    if (query.action == "set") {
      const auto parsed = ParseNumber(query.value.value_or(""));
      if (!parsed) {
        result.error = "desktop_setting_value_invalid";
        return result;
      }
      if (*parsed < 0.5 || *parsed > 2.0) {
        result.error = "desktop_setting_value_out_of_range";
        return result;
      }
      snapshot_.physics_response_scale =
          std::round(*parsed * 100.0) / 100.0;
    }
    result.entry = NumberEntry(
        snapshot_.physics_response_scale, 0.5, 2.0, 0.05);
    return result;
  }

  result.error = "desktop_setting_unsupported";
  return result;
}

}  // namespace ag99::native
