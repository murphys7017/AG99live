#pragma once

#include <string>
#include <string_view>

namespace ag99::live2d {

enum class LogLevel {
  Trace = 0,
  Debug = 1,
  Info = 2,
  Warn = 3,
  Error = 4,
  Off = 5,
};

// The host is a WIN32 subsystem binary, so stderr is not attached when it is
// started from Explorer or a shortcut. Logs therefore always go to a file next
// to the executable, and mirror to stderr only when one exists.
void LogInitialize();

// Redirects std::cerr into the log so existing output, including the Cubism
// SDK's own diagnostics, reaches the log file without touching those call
// sites. Safe to call once; later calls are ignored.
void LogCaptureStderr();

// Directory that receives log files, created on first use. Empty when the
// directory could not be created.
const std::wstring& LogDirectory();

// Active log file, including the currently rotated name. Empty when file
// logging is unavailable.
const std::wstring& LogFilePath();

void LogSetLevel(LogLevel level);
LogLevel LogGetLevel();

// AG99_LOG_LEVEL=trace|debug|info|warn|error, default info.
LogLevel LogLevelFromName(std::string_view name, LogLevel fallback);

void LogWrite(LogLevel level, std::string_view category, std::string_view message);

}  // namespace ag99::live2d

#define AG99_LOG(level, category, message)                                \
  do {                                                                    \
    if ((level) >= ::ag99::live2d::LogGetLevel()) {                       \
      ::ag99::live2d::LogWrite(                                           \
          (level), (category), (message));                                \
    }                                                                     \
  } while (false)

#define AG99_TRACE(category, message) AG99_LOG(::ag99::live2d::LogLevel::Trace, category, message)
#define AG99_DEBUG(category, message) AG99_LOG(::ag99::live2d::LogLevel::Debug, category, message)
#define AG99_INFO(category, message) AG99_LOG(::ag99::live2d::LogLevel::Info, category, message)
#define AG99_WARN(category, message) AG99_LOG(::ag99::live2d::LogLevel::Warn, category, message)
#define AG99_ERROR(category, message) AG99_LOG(::ag99::live2d::LogLevel::Error, category, message)
