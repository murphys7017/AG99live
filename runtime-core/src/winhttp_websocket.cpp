#include "ag99/runtime/winhttp_websocket.hpp"

#include <windows.h>
#include <winhttp.h>

#include <mutex>
#include <string>
#include <utility>

namespace ag99::runtime {
namespace {

std::wstring widen(std::string_view value) {
  if (value.empty()) {
    return {};
  }
  const auto length = MultiByteToWideChar(
      CP_UTF8,
      MB_ERR_INVALID_CHARS,
      value.data(),
      static_cast<int>(value.size()),
      nullptr,
      0);
  if (length <= 0) {
    return {};
  }
  std::wstring output(static_cast<std::size_t>(length), L'\0');
  MultiByteToWideChar(
      CP_UTF8,
      MB_ERR_INVALID_CHARS,
      value.data(),
      static_cast<int>(value.size()),
      output.data(),
      length);
  return output;
}

}  // namespace

struct WinHttpWebSocketClient::Impl {
  HINTERNET session = nullptr;
  HINTERNET connection = nullptr;
  HINTERNET request = nullptr;
  HINTERNET websocket = nullptr;
  std::thread receive_thread;
  std::atomic<bool> running = false;
  std::mutex send_mutex;
  WebSocketCallbacks callbacks;
};

WinHttpWebSocketClient::WinHttpWebSocketClient() : impl_(new Impl) {}

WinHttpWebSocketClient::~WinHttpWebSocketClient() {
  close();
  delete impl_;
}

bool WinHttpWebSocketClient::connect(
    std::string_view url,
    WebSocketCallbacks callbacks) {
  close();
  impl_->callbacks = std::move(callbacks);
  const auto wide_url = widen(url);
  URL_COMPONENTS components{};
  components.dwStructSize = sizeof(components);
  wchar_t host[256]{};
  wchar_t path[2048]{};
  components.lpszHostName = host;
  components.dwHostNameLength = static_cast<DWORD>(std::size(host));
  components.lpszUrlPath = path;
  components.dwUrlPathLength = static_cast<DWORD>(std::size(path));
  if (wide_url.empty() || !WinHttpCrackUrl(
          wide_url.c_str(),
          static_cast<DWORD>(wide_url.size()),
          0,
          &components)) {
    if (impl_->callbacks.on_error) {
      impl_->callbacks.on_error("invalid_websocket_url");
    }
    return false;
  }

  impl_->session = WinHttpOpen(
      L"AG99liveRuntime/0.1",
      WINHTTP_ACCESS_TYPE_DEFAULT_PROXY,
      WINHTTP_NO_PROXY_NAME,
      WINHTTP_NO_PROXY_BYPASS,
      0);
  if (!impl_->session) {
    return false;
  }
  impl_->connection = WinHttpConnect(
      impl_->session,
      components.lpszHostName,
      components.nPort,
      0);
  if (!impl_->connection) {
    close();
    return false;
  }
  const DWORD flags = components.nScheme == INTERNET_SCHEME_HTTPS
      ? WINHTTP_FLAG_SECURE
      : 0;
  impl_->request = WinHttpOpenRequest(
      impl_->connection,
      L"GET",
      components.lpszUrlPath,
      nullptr,
      WINHTTP_NO_REFERER,
      WINHTTP_DEFAULT_ACCEPT_TYPES,
      flags | WINHTTP_FLAG_ESCAPE_DISABLE);
  if (!impl_->request) {
    close();
    return false;
  }
  if (!WinHttpSetOption(
          impl_->request,
          WINHTTP_OPTION_UPGRADE_TO_WEB_SOCKET,
          nullptr,
          0)) {
    close();
    return false;
  }
  if (!WinHttpSendRequest(
          impl_->request,
          WINHTTP_NO_ADDITIONAL_HEADERS,
          0,
          WINHTTP_NO_REQUEST_DATA,
          0,
          0,
          0)
      || !WinHttpReceiveResponse(impl_->request, nullptr)) {
    close();
    return false;
  }
  impl_->websocket = WinHttpWebSocketCompleteUpgrade(impl_->request, 0);
  if (!impl_->websocket) {
    close();
    return false;
  }
  WinHttpCloseHandle(impl_->request);
  impl_->request = nullptr;
  impl_->running = true;
  impl_->receive_thread = std::thread([this] {
    std::vector<std::uint8_t> buffer(64 * 1024);
    std::vector<std::uint8_t> message;
    WINHTTP_WEB_SOCKET_BUFFER_TYPE buffer_type =
        WINHTTP_WEB_SOCKET_UTF8_MESSAGE_BUFFER_TYPE;
    while (impl_->running) {
      DWORD bytes_read = 0;
      const auto result = WinHttpWebSocketReceive(
          impl_->websocket,
          buffer.data(),
          static_cast<DWORD>(buffer.size()),
          &bytes_read,
          &buffer_type);
      if (result != ERROR_SUCCESS) {
        if (impl_->running && impl_->callbacks.on_error) {
          impl_->callbacks.on_error("websocket_receive_failed");
        }
        break;
      }
      if (buffer_type == WINHTTP_WEB_SOCKET_CLOSE_BUFFER_TYPE) {
        break;
      }
      message.insert(message.end(), buffer.begin(), buffer.begin() + bytes_read);
      const bool binary =
          buffer_type == WINHTTP_WEB_SOCKET_BINARY_MESSAGE_BUFFER_TYPE
          || buffer_type == WINHTTP_WEB_SOCKET_BINARY_FRAGMENT_BUFFER_TYPE;
      const bool final =
          buffer_type == WINHTTP_WEB_SOCKET_UTF8_MESSAGE_BUFFER_TYPE
          || buffer_type == WINHTTP_WEB_SOCKET_BINARY_MESSAGE_BUFFER_TYPE;
      if (!final) {
        continue;
      }
      if (binary) {
        if (impl_->callbacks.on_binary) {
          impl_->callbacks.on_binary(std::move(message));
        }
      } else if (impl_->callbacks.on_text) {
        impl_->callbacks.on_text(
            std::string(message.begin(), message.end()));
      }
      message.clear();
    }
    impl_->running = false;
    if (impl_->callbacks.on_closed) {
      impl_->callbacks.on_closed();
    }
  });
  return true;
}

bool WinHttpWebSocketClient::send_text(std::string_view text) {
  std::scoped_lock lock(impl_->send_mutex);
  if (!connected()) {
    return false;
  }
  return WinHttpWebSocketSend(
             impl_->websocket,
             WINHTTP_WEB_SOCKET_UTF8_MESSAGE_BUFFER_TYPE,
             const_cast<char*>(text.data()),
             static_cast<DWORD>(text.size())) == ERROR_SUCCESS;
}

bool WinHttpWebSocketClient::send_binary(
    std::span<const std::uint8_t> payload) {
  std::scoped_lock lock(impl_->send_mutex);
  if (!connected()) {
    return false;
  }
  return WinHttpWebSocketSend(
             impl_->websocket,
             WINHTTP_WEB_SOCKET_BINARY_MESSAGE_BUFFER_TYPE,
             const_cast<std::uint8_t*>(payload.data()),
             static_cast<DWORD>(payload.size())) == ERROR_SUCCESS;
}

void WinHttpWebSocketClient::close() {
  impl_->running = false;
  if (impl_->websocket) {
    WinHttpWebSocketClose(
        impl_->websocket,
        WINHTTP_WEB_SOCKET_SUCCESS_CLOSE_STATUS,
        nullptr,
        0);
  }
  if (impl_->receive_thread.joinable()) {
    impl_->receive_thread.join();
  }
  if (impl_->websocket) {
    WinHttpCloseHandle(impl_->websocket);
    impl_->websocket = nullptr;
  }
  if (impl_->request) {
    WinHttpCloseHandle(impl_->request);
    impl_->request = nullptr;
  }
  if (impl_->connection) {
    WinHttpCloseHandle(impl_->connection);
    impl_->connection = nullptr;
  }
  if (impl_->session) {
    WinHttpCloseHandle(impl_->session);
    impl_->session = nullptr;
  }
}

bool WinHttpWebSocketClient::connected() const noexcept {
  return impl_->running.load() && impl_->websocket != nullptr;
}

}  // namespace ag99::runtime
