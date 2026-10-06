#pragma once

#include <cstddef>
#include <cstdint>
#include <optional>
#include <vector>

namespace ag99::audio {

struct PcmWavInfo {
  std::uint16_t channels = 0;
  std::uint32_t sample_rate = 0;
  std::uint32_t byte_rate = 0;
  std::uint16_t block_align = 0;
  std::uint16_t bits_per_sample = 0;
  std::size_t data_offset = 0;
  std::size_t data_size = 0;
};

std::optional<PcmWavInfo> ParsePcmWav(
    const std::vector<std::uint8_t>& bytes);

bool IsPlayableWav(const std::vector<std::uint8_t>& bytes);

std::optional<double> ReadWavDuration(
    const std::vector<std::uint8_t>& bytes);

std::vector<float> ReadWavRms(
    const std::vector<std::uint8_t>& bytes);

}  // namespace ag99::audio
