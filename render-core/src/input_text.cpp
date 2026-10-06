#include "ag99/platform/input_text.hpp"

#include <windows.h>

#include <algorithm>

namespace ag99::platform {

std::string InputTextToUtf8(std::wstring_view value) {
  if (value.empty()) {
    return {};
  }
  const int length = WideCharToMultiByte(
      CP_UTF8, 0, value.data(), static_cast<int>(value.size()), nullptr, 0,
      nullptr, nullptr);
  if (length <= 0) {
    return {};
  }
  std::string result(static_cast<std::size_t>(length), '\0');
  WideCharToMultiByte(
      CP_UTF8, 0, value.data(), static_cast<int>(value.size()), result.data(),
      length, nullptr, nullptr);
  return result;
}

std::wstring TrimInputText(std::wstring value) {
  const auto is_whitespace = [](wchar_t character) {
    return character == L'\u0009' || character == L'\u000a'
        || character == L'\u000b' || character == L'\u000c'
        || character == L'\u000d' || character == L'\u0020'
        || character == L'\u00a0' || character == L'\u1680'
        || (character >= L'\u2000' && character <= L'\u200a')
        || character == L'\u2028' || character == L'\u2029'
        || character == L'\u202f' || character == L'\u205f'
        || character == L'\u3000' || character == L'\ufeff';
  };
  const auto first = std::find_if_not(value.begin(), value.end(), is_whitespace);
  if (first == value.end()) {
    return {};
  }
  const auto last = std::find_if_not(
      value.rbegin(), value.rend(), is_whitespace).base();
  return std::wstring(first, last);
}

}  // namespace ag99::platform
