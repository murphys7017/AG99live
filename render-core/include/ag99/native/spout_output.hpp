#pragma once

#include <windows.h>

#include <condition_variable>
#include <cstdint>
#include <deque>
#include <filesystem>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "ag99/runtime/protocol.hpp"

namespace ag99::native {

class SpoutOutput final {
public:
  explicit SpoutOutput(std::filesystem::path sender_path);
  ~SpoutOutput();

  SpoutOutput(const SpoutOutput&) = delete;
  SpoutOutput& operator=(const SpoutOutput&) = delete;

  ag99::runtime::DesktopSettingsResult HandleSetting(
      const ag99::runtime::DesktopSettingsQuery& query);
  bool enabled() const noexcept;
  bool PublishFrame(
      std::uint32_t width,
      std::uint32_t height,
      std::vector<std::uint8_t> rgba);
  void Stop() noexcept;

private:
  struct Frame {
    std::uint32_t width = 0;
    std::uint32_t height = 0;
    std::vector<std::uint8_t> rgba;
  };

  static constexpr std::uint32_t kFrameMagic = 0x41473939;
  static constexpr std::size_t kMaxQueuedFrames = 2;
  static constexpr std::size_t kMaxFrameBytes = 256u * 1024u * 1024u;

  bool StartLocked();
  void WorkerLoop();
  bool WriteExact(const void* data, std::size_t size) noexcept;
  static std::wstring QuoteArgument(const std::filesystem::path& path);

  std::filesystem::path sender_path_;
  mutable std::mutex mutex_;
  std::condition_variable condition_;
  std::deque<Frame> frames_;
  HANDLE pipe_ = INVALID_HANDLE_VALUE;
  HANDLE process_ = nullptr;
  std::thread worker_;
  bool enabled_ = false;
  bool stopping_ = false;
  bool failed_ = false;
};

}  // namespace ag99::native
