#pragma once

#include <atomic>
#include <cstdint>
#include <functional>
#include <span>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

namespace ag99::runtime {

struct WebSocketCallbacks {
  std::function<void(std::string)> on_text;
  std::function<void(std::vector<std::uint8_t>)> on_binary;
  std::function<void(std::string)> on_error;
  std::function<void()> on_closed;
};

class WinHttpWebSocketClient final {
 public:
  WinHttpWebSocketClient();
  ~WinHttpWebSocketClient();

  WinHttpWebSocketClient(const WinHttpWebSocketClient&) = delete;
  WinHttpWebSocketClient& operator=(const WinHttpWebSocketClient&) = delete;

  // Receive callbacks run on the receive thread. close() disables new callback
  // invocations and waits for bounded shutdown; callers must keep targets of
  // reference or raw-pointer captures alive until any in-flight callback ends.
  bool connect(std::string_view url, WebSocketCallbacks callbacks);
  bool send_text(std::string_view text);
  bool send_binary(std::span<const std::uint8_t> payload);
  void close();
  bool connected() const;

 private:
  struct Impl;
  Impl* impl_;
};

}  // namespace ag99::runtime
