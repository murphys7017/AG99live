#pragma once

#include <string>
#include <string_view>

namespace ag99::platform {

std::string InputTextToUtf8(std::wstring_view value);
std::wstring TrimInputText(std::wstring value);

}  // namespace ag99::platform
