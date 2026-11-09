#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace ag99::audio {

bool DownloadAudioWav(
    const std::string& url,
    std::vector<std::uint8_t>& output);

}  // namespace ag99::audio
