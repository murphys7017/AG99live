#include "ag99/audio/audio_source.hpp"

#include <cstdio>
#include <iostream>
#include <iterator>
#include <string_view>

#include <windows.h>
#include <winhttp.h>

#include "ag99/audio/wav_audio.hpp"

namespace ag99::audio {

namespace {

// Bound the download so a bad response cannot exhaust memory. 64 MB is about
// half an hour of 16 kHz mono PCM16, far beyond any single spoken reply.
constexpr std::size_t kMaxAudioBytes = 64u * 1024u * 1024u;

std::wstring WidenUtf8(std::string_view value) {
  if (value.empty()) {
    return {};
  }
  const int length = MultiByteToWideChar(
      CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
      static_cast<int>(value.size()), nullptr, 0);
  if (length <= 0) {
    return {};
  }
  std::wstring result(static_cast<std::size_t>(length), L'\0');
  MultiByteToWideChar(
      CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
      static_cast<int>(value.size()), result.data(), length);
  return result;
}

}  // namespace

// The Adapter serves cached audio as a finite PCM WAV. Anything else, including
// an HTML error page from a proxy or a non-200 response, must never reach the
// audio decoder or PlaySound.
bool DownloadAudioWav(
    const std::string& url,
    std::vector<std::uint8_t>& output) {
  const std::wstring wide_url = WidenUtf8(url);
  if (wide_url.empty()) {
    return false;
  }

  URL_COMPONENTS components{};
  components.dwStructSize = sizeof(components);
  wchar_t host[256]{};
  wchar_t path[2048]{};
  wchar_t extra[2048]{};
  components.lpszHostName = host;
  components.dwHostNameLength = std::size(host);
  components.lpszUrlPath = path;
  components.dwUrlPathLength = std::size(path);
  components.lpszExtraInfo = extra;
  components.dwExtraInfoLength = std::size(extra);
  if (!WinHttpCrackUrl(
          wide_url.c_str(), static_cast<DWORD>(wide_url.size()), 0,
          &components)) {
    return false;
  }

  // The audio cache is always loopback. Going through the system proxy would
  // hand us a proxy error page instead of the WAV.
  HINTERNET session = WinHttpOpen(
      L"AG99liveNativeDemo/0.1", WINHTTP_ACCESS_TYPE_NO_PROXY,
      WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
  if (!session) {
    return false;
  }
  HINTERNET connection = WinHttpConnect(
      session, components.lpszHostName, components.nPort, 0);
  const DWORD flags = components.nScheme == INTERNET_SCHEME_HTTPS
      ? WINHTTP_FLAG_SECURE : 0;
  const std::wstring object = std::wstring(path) + extra;
  HINTERNET request = connection
      ? WinHttpOpenRequest(connection, L"GET", object.c_str(), nullptr,
                           WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES,
                           flags)
      : nullptr;
  bool success = false;
  if (request &&
      WinHttpSendRequest(request, WINHTTP_NO_ADDITIONAL_HEADERS, 0,
                         WINHTTP_NO_REQUEST_DATA, 0, 0, 0) &&
      WinHttpReceiveResponse(request, nullptr)) {
    DWORD status = 0;
    DWORD status_size = sizeof(status);
    const bool have_status = WinHttpQueryHeaders(
        request,
        WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
        WINHTTP_HEADER_NAME_BY_INDEX,
        &status,
        &status_size,
        WINHTTP_NO_HEADER_INDEX)
        && status == 200;
    if (!have_status) {
      std::cerr << "audio download rejected, status " << status << ": " << url
                << '\n';
    } else {
      std::uint8_t buffer[64 * 1024];
      DWORD read = 0;
      do {
        if (!WinHttpReadData(request, buffer, sizeof(buffer), &read)) {
          output.clear();
          break;
        }
        if (output.size() + read > kMaxAudioBytes) {
          output.clear();
          break;
        }
        output.insert(output.end(), buffer, buffer + read);
      } while (read != 0);
      if (!output.empty() && !IsPlayableWav(output)) {
        std::cerr << "audio download is not a playable WAV: " << url << '\n';
        output.clear();
      }
      success = !output.empty();
    }
  }
  if (request) {
    WinHttpCloseHandle(request);
  }
  if (connection) {
    WinHttpCloseHandle(connection);
  }
  WinHttpCloseHandle(session);
  return success;
}

std::optional<std::wstring> WriteTempAudio(
    const std::vector<std::uint8_t>& bytes) {
  wchar_t temp_directory[MAX_PATH]{};
  wchar_t temp_file[MAX_PATH]{};
  if (!GetTempPathW(std::size(temp_directory), temp_directory) ||
      !GetTempFileNameW(temp_directory, L"ag9", 0, temp_file)) {
    return std::nullopt;
  }
  FILE* file = nullptr;
  if (_wfopen_s(&file, temp_file, L"wb") != 0 || !file) {
    DeleteFileW(temp_file);
    return std::nullopt;
  }
  const bool written = fwrite(bytes.data(), 1, bytes.size(), file) == bytes.size();
  fclose(file);
  if (!written) {
    DeleteFileW(temp_file);
    return std::nullopt;
  }
  return std::wstring(temp_file);
}

}  // namespace ag99::audio
