#pragma once

#include <string_view>
#include <utility>

#include "ag99/runtime/winhttp_websocket.hpp"

namespace ag99::native {

class NativeTransport final {
public:
  NativeTransport() = default;
  ~NativeTransport() = default;
  NativeTransport(const NativeTransport&) = delete;
  NativeTransport& operator=(const NativeTransport&) = delete;

  bool Connect(std::string_view url, ag99::runtime::WebSocketCallbacks callbacks) {
    return client_.connect(url, std::move(callbacks));
  }
  bool SendText(std::string_view text) { return client_.send_text(text); }
  void Close() { client_.close(); }
  bool Connected() const { return client_.connected(); }
  ag99::runtime::WinHttpWebSocketClient& Client() noexcept { return client_; }

private:
  ag99::runtime::WinHttpWebSocketClient client_;
};

}  // namespace ag99::native
