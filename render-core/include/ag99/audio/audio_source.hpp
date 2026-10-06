#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace ag99::audio {

bool DownloadAudioWav(
    const std::string& url,
    std::vector<std::uint8_t>& output);

std::optional<std::wstring> WriteTempAudio(
    const std::vector<std::uint8_t>& bytes);

}  // namespace ag99::audio
