#include "ag99/runtime/winhttp_websocket.hpp"

#include <stdexcept>

namespace ag99::runtime {

struct WinHttpWebSocketClient::Impl {};

WinHttpWebSocketClient::WinHttpWebSocketClient() : impl_(new Impl) {}
WinHttpWebSocketClient::~WinHttpWebSocketClient() { delete impl_; }

bool WinHttpWebSocketClient::connect(
    std::string_view,
    WebSocketCallbacks callbacks) {
  if (callbacks.on_error) {
    callbacks.on_error("winhttp_websocket_requires_windows");
  }
  return false;
}

bool WinHttpWebSocketClient::send_text(std::string_view) { return false; }
bool WinHttpWebSocketClient::send_binary(
    std::span<const std::uint8_t>) {
  return false;
}
void WinHttpWebSocketClient::close() {}
bool WinHttpWebSocketClient::connected() const noexcept { return false; }

}  // namespace ag99::runtime
