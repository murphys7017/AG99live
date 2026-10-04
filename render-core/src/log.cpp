#include "ag99/live2d/log.hpp"

#include <windows.h>

#include <array>
#include <atomic>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <iostream>
#include <mutex>
#include <streambuf>
#include <string>
#include <system_error>
#include <vector>

namespace ag99::live2d {
namespace {

constexpr std::size_t kMaxFileBytes = 4u * 1024u * 1024u;
constexpr int kKeptFiles = 3;
constexpr std::wstring_view kLogName = L"ag99-render-host.log";

std::mutex g_mutex;
std::atomic<LogLevel> g_level{LogLevel::Info};
std::filesystem::path g_directory;
std::filesystem::path g_file;
std::FILE* g_stream = nullptr;

char ShortLevelName(LogLevel level) {
  switch (level) {
    case LogLevel::Trace: return 'T';
    case LogLevel::Debug: return 'D';
    case LogLevel::Info: return 'I';
    case LogLevel::Warn: return 'W';
    case LogLevel::Error: return 'E';
    case LogLevel::Off: return '?';
  }
  return '?';
}

std::wstring ExecutableDirectory() {
  std::wstring buffer(32768, L'\0');
  const DWORD length = GetModuleFileNameW(
      nullptr, buffer.data(), static_cast<DWORD>(buffer.size()));
  if (length == 0 || static_cast<std::size_t>(length) >= buffer.size()) {
    return {};
  }
  buffer.resize(length);
  return std::filesystem::path(buffer).parent_path().wstring();
}

void RotateLocked() {
  if (!g_stream) {
    return;
  }
  std::fclose(g_stream);
  g_stream = nullptr;

  std::error_code error;
  const auto backup_path = [](int index) {
    return g_file.parent_path() /
        (g_file.filename().wstring() + L"." + std::to_wstring(index));
  };
  for (int index = kKeptFiles - 1; index > 0; --index) {
    const auto source = backup_path(index - 1);
    const auto destination = backup_path(index);
    std::filesystem::remove(destination, error);
    error.clear();
    if (std::filesystem::exists(source, error)) {
      error.clear();
      std::filesystem::rename(source, destination, error);
    }
  }
  const auto oldest = backup_path(0);
  std::filesystem::remove(oldest, error);
  error.clear();
  std::filesystem::rename(g_file, oldest, error);
}

void OpenFileLocked() {
  if (g_directory.empty() || g_file.empty()) {
    return;
  }
  std::error_code error;
  const bool exists = std::filesystem::exists(g_file, error);
  if (exists) {
    const auto size = std::filesystem::file_size(g_file, error);
    if (!error && size >= kMaxFileBytes) {
      RotateLocked();
    }
  }
  _wfopen_s(&g_stream, g_file.c_str(), L"a");
}

std::string FormatTimestamp() {
  SYSTEMTIME time{};
  GetLocalTime(&time);
  std::array<char, 32> buffer{};
  std::snprintf(
      buffer.data(), buffer.size(), "%04u-%02u-%02u %02u:%02u:%02u.%03u",
      time.wYear, time.wMonth, time.wDay, time.wHour, time.wMinute,
      time.wSecond, time.wMilliseconds);
  return std::string(buffer.data());
}

// Forwards everything written to std::cerr into the log. std::cerr is
// unbuffered, so partial lines are reassembled here and emitted on newline.
class StderrCaptureBuffer final : public std::streambuf {
 public:
  std::streamsize xsputn(const char* text, std::streamsize count) override {
    if (count <= 0) {
      return 0;
    }
    Append(text, static_cast<std::size_t>(count));
    return count;
  }

  int overflow(int character) override {
    if (character != EOF) {
      const char value = static_cast<char>(character);
      Append(&value, 1);
    }
    return character;
  }

 private:
  void Append(const char* text, std::size_t count) {
    std::vector<std::string> lines;
    {
      std::scoped_lock lock(g_mutex);
      pending_.append(text, count);
      std::size_t start = 0;
      while (true) {
        const std::size_t end = pending_.find('\n', start);
        if (end == std::string::npos) {
          break;
        }
        std::string_view view(pending_);
        view = view.substr(start, end - start);
        while (!view.empty() && view.back() == '\r') {
          view.remove_suffix(1);
        }
        if (!view.empty()) {
          lines.emplace_back(view);
        }
        start = end + 1;
      }
      pending_.erase(0, start);
    }
    for (const auto& line : lines) {
      LogWrite(LogLevel::Info, "app", line);
    }
  }

  std::string pending_;
};

StderrCaptureBuffer g_capture;
std::atomic<bool> g_capture_installed{false};

}  // namespace

LogLevel LogLevelFromName(std::string_view name, LogLevel fallback) {
  if (name == "trace") return LogLevel::Trace;
  if (name == "debug") return LogLevel::Debug;
  if (name == "info") return LogLevel::Info;
  if (name == "warn") return LogLevel::Warn;
  if (name == "error") return LogLevel::Error;
  if (name == "off") return LogLevel::Off;
  return fallback;
}

void LogSetLevel(LogLevel level) {
  g_level.store(level, std::memory_order_relaxed);
}

LogLevel LogGetLevel() {
  return g_level.load(std::memory_order_relaxed);
}

void LogInitialize() {
  std::scoped_lock lock(g_mutex);

  if (const char* configured = std::getenv("AG99_LOG_LEVEL")) {
    g_level.store(LogLevelFromName(configured, LogLevel::Info));
  }

  const std::wstring base = ExecutableDirectory();
  if (base.empty()) {
    return;
  }
  std::error_code error;
  std::filesystem::create_directories(base + L"\\logs", error);
  if (error) {
    return;
  }
  g_directory = std::filesystem::path(base + L"\\logs");
  g_file = g_directory / kLogName;
  OpenFileLocked();
}

void LogCaptureStderr() {
  if (g_capture_installed.exchange(true)) {
    return;
  }
  std::cerr.rdbuf(&g_capture);
}

const std::wstring& LogDirectory() {
  static const std::wstring value = g_directory.wstring();
  return value;
}

const std::wstring& LogFilePath() {
  static const std::wstring value = g_file.wstring();
  return value;
}

void LogWrite(
    LogLevel level, std::string_view category, std::string_view message) {
  std::string line = FormatTimestamp();
  line += " [";
  line += ShortLevelName(level);
  line += "] ";
  line += category;
  line += ": ";
  line += message;
  line += '\n';

  std::scoped_lock lock(g_mutex);
  if (g_stream) {
    std::fwrite(line.data(), 1, line.size(), g_stream);
    std::fflush(g_stream);
  }
  if (const HANDLE stderr_handle = GetStdHandle(STD_ERROR_HANDLE);
      stderr_handle != nullptr && stderr_handle != INVALID_HANDLE_VALUE) {
    DWORD written = 0;
    WriteFile(
        stderr_handle, line.data(), static_cast<DWORD>(line.size()), &written,
        nullptr);
  }
}

}  // namespace ag99::live2d
