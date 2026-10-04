#include "ag99/runtime/winhttp_websocket.hpp"

#include <windows.h>
#include <winhttp.h>

#include <chrono>
#include <condition_variable>
#include <memory>
#include <mutex>
#include <optional>
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
  struct ConnectionState {
    HINTERNET session = nullptr;
    HINTERNET connection = nullptr;
    HINTERNET request = nullptr;
    HINTERNET websocket = nullptr;
    std::thread receive_thread;
    std::mutex thread_mutex;
    std::mutex start_mutex;
    std::condition_variable start_condition;
    bool start_ready = false;
    std::atomic<HANDLE> receive_thread_handle = nullptr;
    std::atomic<DWORD> receive_thread_id = 0;
    std::atomic<bool> receive_exited = true;
    std::atomic<bool> running = false;
    std::atomic<bool> close_requested = false;
    std::atomic<bool> close_handshake_started = false;
    std::atomic<bool> peer_close_received = false;
    std::mutex callback_mutex;
    std::condition_variable callback_condition;
    std::size_t callbacks_in_flight = 0;
    bool callbacks_enabled = true;
    std::mutex send_mutex;
    std::mutex finalization_mutex;
    std::mutex exit_mutex;
    std::condition_variable exit_condition;
    WebSocketCallbacks callbacks;

    template <typename Callback>
    void invoke_callback(Callback&& callback) {
      {
        std::scoped_lock lock(callback_mutex);
        if (!callbacks_enabled) {
          return;
        }
        ++callbacks_in_flight;
      }
      struct CallbackCompletion {
        ConnectionState& state;
        ~CallbackCompletion() {
          {
            std::scoped_lock lock(state.callback_mutex);
            --state.callbacks_in_flight;
          }
          state.callback_condition.notify_all();
        }
      } completion{*this};
      try {
        std::forward<Callback>(callback)();
      } catch (...) {
        // A user callback must never escape the receive thread and invoke
        // std::terminate. The callback owner remains responsible for logging.
      }
    }

    void disable_callbacks() {
      std::scoped_lock lock(callback_mutex);
      callbacks_enabled = false;
    }

    void close_handles() {
      std::scoped_lock lock(send_mutex);
      if (websocket) {
        WinHttpCloseHandle(websocket);
        websocket = nullptr;
      }
      if (request) {
        WinHttpCloseHandle(request);
        request = nullptr;
      }
      if (connection) {
        WinHttpCloseHandle(connection);
        connection = nullptr;
      }
      if (session) {
        WinHttpCloseHandle(session);
        session = nullptr;
      }
    }

    ~ConnectionState() { close_handles(); }
  };

  std::mutex lifecycle_mutex;
  std::mutex connection_mutex;
  std::shared_ptr<ConnectionState> connection;

  void close_current() {
    std::shared_ptr<ConnectionState> state;
    {
      std::scoped_lock lock(connection_mutex);
      state = std::move(connection);
    }
    if (!state) {
      return;
    }

    const bool called_from_receiver =
        state->receive_thread_id.load() == GetCurrentThreadId();
    {
      std::scoped_lock lock(state->finalization_mutex);
      state->running = false;
      state->close_requested = true;
    }
    state->disable_callbacks();

    bool thread_joinable = false;
    HANDLE receive_handle = nullptr;
    {
      std::scoped_lock lock(state->thread_mutex);
      thread_joinable = state->receive_thread.joinable();
      if (thread_joinable && !called_from_receiver) {
        receive_handle = state->receive_thread_handle.load();
      }
    }
    if (!thread_joinable) {
      state->close_handles();
    } else if (called_from_receiver) {
      // The worker owns this connection until its callback returns and the
      // receive loop performs protocol close and handle cleanup.
      std::scoped_lock lock(state->thread_mutex);
      if (state->receive_thread.joinable()) {
        state->receive_thread.detach();
      }
      state->receive_thread_handle = nullptr;
      return;
    }

    if (receive_handle) {
      CancelSynchronousIo(receive_handle);
    }

    constexpr auto kReceiveDrainTimeout = std::chrono::milliseconds(1500);
    {
      std::unique_lock lock(state->exit_mutex);
      state->exit_condition.wait_for(
          lock,
          kReceiveDrainTimeout,
          [&] { return state->receive_exited.load(); });
    }

    // Callback execution is owned by the application. Do not wait forever
    // for a callback that synchronously waits on this close operation. The
    // shared state keeps callback objects alive, but captured references
    // remain the caller's responsibility.
    {
      std::unique_lock lock(state->callback_mutex);
      state->callback_condition.wait_for(
          lock,
          kReceiveDrainTimeout,
          [&] { return state->callbacks_in_flight == 0; });
    }

    // Detaching is safe because the receive lambda owns `state`; it never
    // refers to this client or its Impl. On timeout it will close the
    // connection handles itself after Receive exits.
    std::scoped_lock lock(state->thread_mutex);
    if (state->receive_thread.joinable()) {
      state->receive_thread.detach();
    }
    state->receive_thread_handle = nullptr;
  }
};

WinHttpWebSocketClient::WinHttpWebSocketClient() : impl_(new Impl) {}

WinHttpWebSocketClient::~WinHttpWebSocketClient() {
  close();
  delete impl_;
}

bool WinHttpWebSocketClient::connect(
    std::string_view url,
    WebSocketCallbacks callbacks) {
  std::unique_lock lifecycle_lock(impl_->lifecycle_mutex);
  impl_->close_current();
  using ConnectionState = Impl::ConnectionState;
  auto state = std::make_shared<ConnectionState>();
  state->callbacks = std::move(callbacks);
  const auto fail_connect = [&](std::string error = {}) {
    state->close_handles();
    lifecycle_lock.unlock();
    if (!error.empty() && state->callbacks.on_error) {
      try {
        state->callbacks.on_error(std::move(error));
      } catch (...) {
        // A connection failure must not let an application callback escape
        // through the public connect() boundary.
      }
    }
    return false;
  };
  const auto wide_url = widen(url);
  std::wstring http_url;
  if (wide_url.starts_with(L"ws://")) {
    http_url = L"http://" + wide_url.substr(5);
  } else if (wide_url.starts_with(L"wss://")) {
    http_url = L"https://" + wide_url.substr(6);
  } else {
    return fail_connect("invalid_websocket_url");
  }
  URL_COMPONENTS components{};
  components.dwStructSize = sizeof(components);
  wchar_t host[256]{};
  wchar_t path[2048]{};
  components.lpszHostName = host;
  components.dwHostNameLength = static_cast<DWORD>(std::size(host));
  components.lpszUrlPath = path;
  components.dwUrlPathLength = static_cast<DWORD>(std::size(path));
  if (wide_url.empty() || !WinHttpCrackUrl(
          http_url.c_str(),
          static_cast<DWORD>(http_url.size()),
          0,
          &components)) {
    return fail_connect("invalid_websocket_url");
  }

  state->session = WinHttpOpen(
      L"AG99liveRuntime/0.1",
      WINHTTP_ACCESS_TYPE_DEFAULT_PROXY,
      WINHTTP_NO_PROXY_NAME,
      WINHTTP_NO_PROXY_BYPASS,
      0);
  if (!state->session) {
    return fail_connect();
  }
  WinHttpSetTimeouts(state->session, 3000, 3000, 3000, 3000);
  state->connection = WinHttpConnect(
      state->session,
      components.lpszHostName,
      components.nPort,
      0);
  if (!state->connection) {
    return fail_connect();
  }
  const DWORD flags = components.nScheme == INTERNET_SCHEME_HTTPS
      ? WINHTTP_FLAG_SECURE
      : 0;
  state->request = WinHttpOpenRequest(
      state->connection,
      L"GET",
      components.lpszUrlPath,
      nullptr,
      WINHTTP_NO_REFERER,
      WINHTTP_DEFAULT_ACCEPT_TYPES,
      flags | WINHTTP_FLAG_ESCAPE_DISABLE);
  if (!state->request) {
    return fail_connect();
  }
  if (!WinHttpSetOption(
          state->request,
          WINHTTP_OPTION_UPGRADE_TO_WEB_SOCKET,
          nullptr,
          0)) {
    return fail_connect();
  }
  if (!WinHttpSendRequest(
          state->request,
          WINHTTP_NO_ADDITIONAL_HEADERS,
          0,
          WINHTTP_NO_REQUEST_DATA,
          0,
          0,
          0)
      || !WinHttpReceiveResponse(state->request, nullptr)) {
    return fail_connect();
  }
  state->websocket = WinHttpWebSocketCompleteUpgrade(state->request, 0);
  if (!state->websocket) {
    return fail_connect();
  }
  WinHttpCloseHandle(state->request);
  state->request = nullptr;
  DWORD close_timeout_ms = 750;
  if (!WinHttpSetOption(
          state->websocket,
          WINHTTP_OPTION_WEB_SOCKET_CLOSE_TIMEOUT,
          &close_timeout_ms,
          sizeof(close_timeout_ms))) {
    return fail_connect("websocket_close_timeout_configuration_failed");
  }
  state->receive_exited = false;
  state->running = true;
  try {
    state->receive_thread = std::thread([state] {
      struct ReceiveExitNotification {
        ConnectionState& state;
        ~ReceiveExitNotification() {
          state.receive_thread_id.store(0);
          state.receive_exited.store(true);
          state.exit_condition.notify_all();
        }
      } exit_notification{*state};
      {
        std::unique_lock lock(state->start_mutex);
        state->start_condition.wait(lock, [&] { return state->start_ready; });
      }
      state->receive_thread_id.store(GetCurrentThreadId());
      try {
        std::vector<std::uint8_t> buffer(64 * 1024);
        std::vector<std::uint8_t> message;
        WINHTTP_WEB_SOCKET_BUFFER_TYPE buffer_type =
            WINHTTP_WEB_SOCKET_UTF8_MESSAGE_BUFFER_TYPE;
        while (state->running) {
          DWORD bytes_read = 0;
          const auto result = WinHttpWebSocketReceive(
              state->websocket,
              buffer.data(),
              static_cast<DWORD>(buffer.size()),
              &bytes_read,
              &buffer_type);
          if (result != ERROR_SUCCESS) {
            state->invoke_callback([&] {
              if (state->callbacks.on_error) {
                state->callbacks.on_error(
                    "websocket_receive_failed:" + std::to_string(result));
              }
            });
            break;
          }
          if (buffer_type == WINHTTP_WEB_SOCKET_CLOSE_BUFFER_TYPE) {
            state->peer_close_received = true;
            break;
          }
          bool binary = false;
          bool final = false;
          switch (buffer_type) {
          case WINHTTP_WEB_SOCKET_BINARY_MESSAGE_BUFFER_TYPE:
            binary = true;
            final = true;
            break;
          case WINHTTP_WEB_SOCKET_BINARY_FRAGMENT_BUFFER_TYPE:
            binary = true;
            break;
          case WINHTTP_WEB_SOCKET_UTF8_MESSAGE_BUFFER_TYPE:
            final = true;
            break;
          case WINHTTP_WEB_SOCKET_UTF8_FRAGMENT_BUFFER_TYPE:
            break;
          default:
            state->invoke_callback([&] {
              if (state->callbacks.on_error) {
                state->callbacks.on_error("websocket_unknown_buffer_type");
              }
            });
            message.clear();
            continue;
          }
          message.insert(
              message.end(), buffer.begin(), buffer.begin() + bytes_read);
          if (!final) {
            continue;
          }
          if (binary) {
            state->invoke_callback([&] {
              if (state->callbacks.on_binary) {
                state->callbacks.on_binary(std::move(message));
              }
            });
          } else {
            state->invoke_callback([&] {
              if (state->callbacks.on_text) {
                state->callbacks.on_text(
                    std::string(message.begin(), message.end()));
              }
            });
          }
          message.clear();
        }
      } catch (const std::exception&) {
        state->invoke_callback([&] {
          if (state->callbacks.on_error) {
            state->callbacks.on_error("websocket_receive_worker_failed");
          }
        });
      } catch (...) {
        state->invoke_callback([&] {
          if (state->callbacks.on_error) {
            state->callbacks.on_error("websocket_receive_worker_failed");
          }
        });
      }
      state->running = false;
      const auto close_protocol_locked = [&]() -> std::optional<DWORD> {
        if (!state->peer_close_received && !state->close_requested) {
          return std::nullopt;
        }
        bool expected = false;
        if (!state->close_handshake_started.compare_exchange_strong(
                expected,
                true)) {
          return std::nullopt;
        }
        std::scoped_lock lock(state->send_mutex);
        if (!state->websocket) {
          return std::nullopt;
        }
        return WinHttpWebSocketClose(
            state->websocket,
            WINHTTP_WEB_SOCKET_SUCCESS_CLOSE_STATUS,
            nullptr,
            0);
      };
      const auto report_close_result = [&](std::optional<DWORD> result) {
        if (result && *result != ERROR_SUCCESS) {
          state->invoke_callback([&] {
            if (state->callbacks.on_error) {
              state->callbacks.on_error(
                  "websocket_close_failed:" + std::to_string(*result));
            }
          });
        }
      };
      const auto close_protocol = [&] {
        std::optional<DWORD> result;
        {
          std::scoped_lock lock(state->finalization_mutex);
          result = close_protocol_locked();
        }
        report_close_result(result);
      };
      close_protocol();
      state->invoke_callback([&] {
        if (state->callbacks.on_closed) {
          state->callbacks.on_closed();
        }
      });
      close_protocol();
      std::optional<DWORD> final_close_result;
      {
        std::scoped_lock lock(state->finalization_mutex);
        final_close_result = close_protocol_locked();
        state->close_handles();
      }
      report_close_result(final_close_result);
    });
  } catch (...) {
    state->running = false;
    return fail_connect("websocket_receive_thread_start_failed");
  }
  // Keep the real kernel thread handle. GetCurrentThread() would return a
  // pseudo-handle whose meaning changes with the calling thread, so it cannot
  // be passed to CancelSynchronousIo from close().
  {
    std::scoped_lock lock(state->thread_mutex);
    state->receive_thread_handle.store(state->receive_thread.native_handle());
  }
  {
    std::scoped_lock lock(impl_->connection_mutex);
    impl_->connection = state;
  }
  {
    std::scoped_lock lock(state->start_mutex);
    state->start_ready = true;
  }
  state->start_condition.notify_one();
  return true;
}

bool WinHttpWebSocketClient::send_text(std::string_view text) {
  std::shared_ptr<Impl::ConnectionState> state;
  {
    std::scoped_lock lock(impl_->connection_mutex);
    state = impl_->connection;
  }
  if (!state) {
    return false;
  }
  std::scoped_lock lock(state->send_mutex);
  if (!state->running.load() || !state->websocket) {
    return false;
  }
  return WinHttpWebSocketSend(
             state->websocket,
             WINHTTP_WEB_SOCKET_UTF8_MESSAGE_BUFFER_TYPE,
             const_cast<char*>(text.data()),
             static_cast<DWORD>(text.size())) == ERROR_SUCCESS;
}

bool WinHttpWebSocketClient::send_binary(
    std::span<const std::uint8_t> payload) {
  std::shared_ptr<Impl::ConnectionState> state;
  {
    std::scoped_lock lock(impl_->connection_mutex);
    state = impl_->connection;
  }
  if (!state) {
    return false;
  }
  std::scoped_lock lock(state->send_mutex);
  if (!state->running.load() || !state->websocket) {
    return false;
  }
  return WinHttpWebSocketSend(
             state->websocket,
             WINHTTP_WEB_SOCKET_BINARY_MESSAGE_BUFFER_TYPE,
             const_cast<std::uint8_t*>(payload.data()),
             static_cast<DWORD>(payload.size())) == ERROR_SUCCESS;
}

void WinHttpWebSocketClient::close() {
  std::scoped_lock lifecycle_lock(impl_->lifecycle_mutex);
  impl_->close_current();
}

bool WinHttpWebSocketClient::connected() const {
  std::shared_ptr<Impl::ConnectionState> state;
  {
    std::scoped_lock lock(impl_->connection_mutex);
    state = impl_->connection;
  }
  if (!state) {
    return false;
  }
  std::scoped_lock lock(state->send_mutex);
  return state->running.load() && state->websocket != nullptr;
}

}  // namespace ag99::runtime
