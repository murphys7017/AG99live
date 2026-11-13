#pragma once

#include <optional>
#include <string>

namespace ag99::native {

// Capture the current virtual desktop as bounded base64 JPEG data. The
// function is synchronous and intended for the bounded observation request
// path, not for a continuous capture loop.
std::optional<std::string> CaptureDesktopJpeg(std::string& error);

}  // namespace ag99::native
