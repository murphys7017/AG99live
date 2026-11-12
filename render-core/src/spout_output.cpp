#include <windows.h>

#include <algorithm>
#include <cstdint>
#include <filesystem>
#include <string>
#include <utility>

#include "ag99/native/spout_output.hpp"

namespace ag99::native {
namespace {

struct FrameHeader {
  std::uint32_t magic;
  std::uint32_t width;
  std::uint32_t height;
  std::uint32_t byte_length;
};

static_assert(sizeof(FrameHeader) == 16);

}  // namespace

SpoutOutput::SpoutOutput(std::filesystem::path sender_path)
    : sender_path_(std::move(sender_path)) {}

SpoutOutput::~SpoutOutput() {
  Stop();
}

bool SpoutOutput::enabled() const noexcept {
  std::scoped_lock lock(mutex_);
  return enabled_ && !failed_;
}

ag99::runtime::DesktopSettingsResult SpoutOutput::HandleSetting(
    const ag99::runtime::DesktopSettingsQuery& query) {
  ag99::runtime::DesktopSettingsResult result{
      query.request_id,
      query.key,
      std::nullopt,
      {}};
  if (query.action == "set") {
    const auto value = query.value.value_or("");
    if (value != "true" && value != "false") {
      result.error = "desktop_setting_value_invalid";
      return result;
    }
    const bool requested = value == "true";
    if (requested) {
      bool retry_failed = false;
      {
        std::scoped_lock lock(mutex_);
        retry_failed = failed_;
      }
      if (retry_failed) {
        Stop();
      }
      std::scoped_lock lock(mutex_);
      enabled_ = true;
      if (!StartLocked()) {
        enabled_ = false;
        result.error = "desktop_setting_failed";
        return result;
      }
    } else {
      {
        std::scoped_lock lock(mutex_);
        enabled_ = false;
      }
      Stop();
    }
  }
  std::scoped_lock lock(mutex_);
  result.entry = ag99::runtime::DesktopSettingsEntry{
      enabled_ && !failed_ ? "true" : "false",
      {},
      std::nullopt,
      std::nullopt,
      std::nullopt};
  return result;
}

bool SpoutOutput::PublishFrame(
    std::uint32_t width,
    std::uint32_t height,
    std::vector<std::uint8_t> rgba) {
  if (width == 0 || height == 0
      || static_cast<std::uint64_t>(width) * height * 4
          > kMaxFrameBytes
      || rgba.size() != static_cast<std::size_t>(width) * height * 4) {
    return false;
  }
  std::scoped_lock lock(mutex_);
  if (!enabled_ || failed_ || stopping_ || pipe_ == INVALID_HANDLE_VALUE) {
    return false;
  }
  if (frames_.size() >= kMaxQueuedFrames) {
    frames_.pop_front();
  }
  frames_.push_back(Frame{width, height, std::move(rgba)});
  condition_.notify_one();
  return true;
}

bool SpoutOutput::StartLocked() {
  if (pipe_ != INVALID_HANDLE_VALUE && worker_.joinable()) {
    return true;
  }
  if (sender_path_.empty() || GetFileAttributesW(sender_path_.c_str())
      == INVALID_FILE_ATTRIBUTES) {
    failed_ = true;
    return false;
  }

  SECURITY_ATTRIBUTES attributes{};
  attributes.nLength = sizeof(attributes);
  attributes.bInheritHandle = TRUE;
  HANDLE child_read = INVALID_HANDLE_VALUE;
  if (!CreatePipe(&child_read, &pipe_, &attributes, 0)) {
    failed_ = true;
    return false;
  }
  if (!SetHandleInformation(pipe_, HANDLE_FLAG_INHERIT, 0)) {
    CloseHandle(child_read);
    CloseHandle(pipe_);
    child_read = INVALID_HANDLE_VALUE;
    pipe_ = INVALID_HANDLE_VALUE;
    failed_ = true;
    return false;
  }

  HANDLE null_output = CreateFileW(
      L"NUL", GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
      &attributes, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (null_output == INVALID_HANDLE_VALUE) {
    CloseHandle(child_read);
    CloseHandle(pipe_);
    child_read = INVALID_HANDLE_VALUE;
    pipe_ = INVALID_HANDLE_VALUE;
    failed_ = true;
    return false;
  }

  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  startup.dwFlags = STARTF_USESTDHANDLES;
  startup.hStdInput = child_read;
  startup.hStdOutput = null_output;
  startup.hStdError = null_output;
  PROCESS_INFORMATION process_info{};
  std::wstring command = QuoteArgument(sender_path_)
      + L" --sender AG99live.Live2D";
  const bool created = CreateProcessW(
      nullptr,
      command.data(),
      nullptr,
      nullptr,
      TRUE,
      CREATE_NO_WINDOW,
      nullptr,
      sender_path_.parent_path().c_str(),
      &startup,
      &process_info) != FALSE;
  CloseHandle(child_read);
  CloseHandle(null_output);
  if (!created) {
    CloseHandle(pipe_);
    pipe_ = INVALID_HANDLE_VALUE;
    failed_ = true;
    return false;
  }
  CloseHandle(process_info.hThread);
  process_ = process_info.hProcess;
  stopping_ = false;
  failed_ = false;
  worker_ = std::thread([this] { WorkerLoop(); });
  return true;
}

void SpoutOutput::Stop() noexcept {
  std::thread worker;
  HANDLE process = nullptr;
  {
    std::scoped_lock lock(mutex_);
    enabled_ = false;
    stopping_ = true;
    condition_.notify_all();
    const HANDLE pipe = pipe_;
    pipe_ = INVALID_HANDLE_VALUE;
    if (pipe != INVALID_HANDLE_VALUE) {
      CloseHandle(pipe);
    }
    worker = std::move(worker_);
    process = process_;
    process_ = nullptr;
    frames_.clear();
  }
  if (worker.joinable()) {
    worker.join();
  }
  if (process) {
    if (WaitForSingleObject(process, 1000) == WAIT_TIMEOUT) {
      TerminateProcess(process, 1);
      WaitForSingleObject(process, 1000);
    }
    CloseHandle(process);
  }
  std::scoped_lock lock(mutex_);
  stopping_ = false;
}

void SpoutOutput::WorkerLoop() {
  while (true) {
    Frame frame;
    {
      std::unique_lock lock(mutex_);
      condition_.wait(lock, [this] {
        return stopping_ || !frames_.empty();
      });
      if (stopping_ && frames_.empty()) {
        return;
      }
      frame = std::move(frames_.front());
      frames_.pop_front();
    }
    const FrameHeader header{
        kFrameMagic,
        frame.width,
        frame.height,
        static_cast<std::uint32_t>(frame.rgba.size())};
    if (!WriteExact(&header, sizeof(header))
        || !WriteExact(frame.rgba.data(), frame.rgba.size())) {
      std::scoped_lock lock(mutex_);
      const HANDLE pipe = pipe_;
      pipe_ = INVALID_HANDLE_VALUE;
      if (pipe != INVALID_HANDLE_VALUE) {
        CloseHandle(pipe);
      }
      failed_ = true;
      enabled_ = false;
      frames_.clear();
      return;
    }
  }
}

bool SpoutOutput::WriteExact(const void* data, std::size_t size) noexcept {
  const auto* cursor = static_cast<const std::uint8_t*>(data);
  while (size > 0) {
    DWORD written = 0;
    const DWORD request = static_cast<DWORD>(std::min<std::size_t>(size, MAXDWORD));
    if (!WriteFile(pipe_, cursor, request, &written, nullptr) || written == 0) {
      return false;
    }
    cursor += written;
    size -= written;
  }
  return true;
}

std::wstring SpoutOutput::QuoteArgument(const std::filesystem::path& path) {
  std::wstring value = L"\"" + path.wstring() + L"\"";
  return value;
}

}  // namespace ag99::native
