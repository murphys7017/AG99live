#include "ag99/audio/wav_audio.hpp"

#include <algorithm>
#include <cmath>
#include <cstring>

namespace ag99::audio {

namespace {

std::uint16_t ReadLittleEndian16(const std::uint8_t* value) {
  return static_cast<std::uint16_t>(value[0])
      | static_cast<std::uint16_t>(value[1] << 8);
}

std::uint32_t ReadLittleEndian32(const std::uint8_t* value) {
  return static_cast<std::uint32_t>(value[0])
      | (static_cast<std::uint32_t>(value[1]) << 8)
      | (static_cast<std::uint32_t>(value[2]) << 16)
      | (static_cast<std::uint32_t>(value[3]) << 24);
}

}  // namespace

std::optional<PcmWavInfo> ParsePcmWav(
    const std::vector<std::uint8_t>& bytes) {
  if (bytes.size() < 12 || std::memcmp(bytes.data(), "RIFF", 4) != 0
      || std::memcmp(bytes.data() + 8, "WAVE", 4) != 0) {
    return std::nullopt;
  }

  const std::uint32_t riff_size = ReadLittleEndian32(bytes.data() + 4);
  if (riff_size < 4 || static_cast<std::size_t>(riff_size) != bytes.size() - 8) {
    return std::nullopt;
  }

  const std::size_t riff_end = bytes.size();
  PcmWavInfo info{};
  bool have_format = false;
  bool have_data = false;
  std::uint16_t format_tag = 0;
  for (std::size_t offset = 12; offset < riff_end;) {
    if (riff_end - offset < 8) {
      return std::nullopt;
    }
    const std::size_t chunk_size = ReadLittleEndian32(bytes.data() + offset + 4);
    const std::size_t chunk_data = offset + 8;
    const std::size_t remaining = riff_end - chunk_data;
    const std::size_t padded_size = chunk_size + (chunk_size & 1u);
    if (padded_size > remaining) {
      return std::nullopt;
    }

    if (std::memcmp(bytes.data() + offset, "fmt ", 4) == 0) {
      if (have_format || have_data || chunk_size < 16) {
        return std::nullopt;
      }
      format_tag = ReadLittleEndian16(bytes.data() + chunk_data);
      info.channels = ReadLittleEndian16(bytes.data() + chunk_data + 2);
      info.sample_rate = ReadLittleEndian32(bytes.data() + chunk_data + 4);
      info.byte_rate = ReadLittleEndian32(bytes.data() + chunk_data + 8);
      info.block_align = ReadLittleEndian16(bytes.data() + chunk_data + 12);
      info.bits_per_sample = ReadLittleEndian16(bytes.data() + chunk_data + 14);
      have_format = true;
    } else if (std::memcmp(bytes.data() + offset, "data", 4) == 0) {
      if (!have_format || have_data || chunk_size == 0) {
        return std::nullopt;
      }
      info.data_offset = chunk_data;
      info.data_size = chunk_size;
      have_data = true;
    }

    offset = chunk_data + padded_size;
  }

  if (!have_format || !have_data || format_tag != 1 || info.channels == 0
      || info.sample_rate == 0 || info.bits_per_sample < 8
      || info.bits_per_sample % 8 != 0) {
    return std::nullopt;
  }
  const std::uint64_t bytes_per_sample = info.bits_per_sample / 8;
  const std::uint64_t expected_block_align =
      static_cast<std::uint64_t>(info.channels) * bytes_per_sample;
  const std::uint64_t expected_byte_rate =
      static_cast<std::uint64_t>(info.sample_rate) * expected_block_align;
  if (expected_block_align != info.block_align
      || expected_byte_rate != info.byte_rate
      || info.data_size % info.block_align != 0) {
    return std::nullopt;
  }
  return info;
}

bool IsPlayableWav(const std::vector<std::uint8_t>& bytes) {
  return ParsePcmWav(bytes).has_value();
}

std::optional<double> ReadWavDuration(
    const std::vector<std::uint8_t>& bytes) {
  const auto info = ParsePcmWav(bytes);
  if (!info) {
    return std::nullopt;
  }
  return static_cast<double>(info->data_size) / info->byte_rate;
}

std::vector<float> ReadWavRms(
    const std::vector<std::uint8_t>& bytes) {
  const auto info = ParsePcmWav(bytes);
  if (!info || info->bits_per_sample != 16) {
    return {};
  }
  const std::size_t bytes_per_frame = info->block_align;
  const std::size_t frame_count = info->data_size / bytes_per_frame;
  const std::size_t frames_per_bucket =
      std::max<std::size_t>(1, info->sample_rate / 50);
  std::vector<float> result;
  result.reserve((frame_count + frames_per_bucket - 1) / frames_per_bucket);
  for (std::size_t first = 0; first < frame_count; first += frames_per_bucket) {
    const std::size_t count = std::min(frames_per_bucket, frame_count - first);
    double square_sum = 0.0;
    for (std::size_t frame = 0; frame < count; ++frame) {
      for (std::size_t channel = 0; channel < info->channels; ++channel) {
        const auto offset = info->data_offset
            + (first + frame) * bytes_per_frame + channel * 2;
        std::int16_t sample = 0;
        std::memcpy(&sample, bytes.data() + offset, sizeof(sample));
        const double normalized = static_cast<double>(sample) / 32768.0;
        square_sum += normalized * normalized;
      }
    }
    const double sample_count = static_cast<double>(count) * info->channels;
    result.push_back(static_cast<float>(
        std::sqrt(square_sum / std::max(1.0, sample_count))));
  }
  return result;
}

}  // namespace ag99::audio
