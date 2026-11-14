#include "ag99/native/bilibili_live_runtime.hpp"

#include <windows.h>
#include <winhttp.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <iterator>
#include <mutex>
#include <nlohmann/json.hpp>
#include <optional>
#include <sstream>
#include <thread>
#include <utility>
#include <vector>

#include "ag99/runtime/winhttp_websocket.hpp"

namespace ag99::native {
namespace {

using Json = nlohmann::json;

constexpr char kDefaultHost[] = "broadcastlv.chat.bilibili.com";
constexpr std::size_t kMaxBatchSize = 8;
constexpr std::size_t kMaxBufferSize = 80;

std::wstring Widen(std::string_view value) {
  if (value.empty()) return {};
  const int length = MultiByteToWideChar(
      CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
      static_cast<int>(value.size()), nullptr, 0);
  if (length <= 0) return {};
  std::wstring output(static_cast<std::size_t>(length), L'\0');
  MultiByteToWideChar(
      CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
      static_cast<int>(value.size()), output.data(), length);
  return output;
}

std::string ReadHttp(std::string_view host, std::wstring_view path,
                     std::string_view cookie) {
  const auto host_wide = Widen(host);
  HINTERNET session = WinHttpOpen(
      L"AG99live Native/1.0", WINHTTP_ACCESS_TYPE_DEFAULT_PROXY,
      WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
  if (!session) return {};
  HINTERNET connection = WinHttpConnect(
      session, host_wide.c_str(), INTERNET_DEFAULT_HTTPS_PORT, 0);
  if (!connection) {
    WinHttpCloseHandle(session);
    return {};
  }
  HINTERNET request = WinHttpOpenRequest(
      connection, L"GET", path.data(), nullptr, WINHTTP_NO_REFERER,
      WINHTTP_DEFAULT_ACCEPT_TYPES, WINHTTP_FLAG_SECURE);
  if (!request) {
    WinHttpCloseHandle(connection);
    WinHttpCloseHandle(session);
    return {};
  }
  const auto cookie_wide = Widen(cookie);
  if (!cookie_wide.empty()) {
    WinHttpAddRequestHeaders(
        request, (L"Cookie: " + cookie_wide + L"\r\n").c_str(),
        static_cast<DWORD>(-1L), WINHTTP_ADDREQ_FLAG_ADD);
  }
  const bool sent = WinHttpSendRequest(
      request, WINHTTP_NO_ADDITIONAL_HEADERS, 0, WINHTTP_NO_REQUEST_DATA, 0,
      0, 0) && WinHttpReceiveResponse(request, nullptr);
  std::string output;
  if (sent) {
    DWORD available = 0;
    while (WinHttpQueryDataAvailable(request, &available) && available > 0) {
      const auto offset = output.size();
      output.resize(offset + available);
      DWORD read = 0;
      if (!WinHttpReadData(request, output.data() + offset, available, &read)
          || read == 0) {
        output.resize(offset);
        break;
      }
      output.resize(offset + read);
    }
  }
  WinHttpCloseHandle(request);
  WinHttpCloseHandle(connection);
  WinHttpCloseHandle(session);
  return output;
}

std::uint32_t ReadBe32(const std::uint8_t* value) {
  return (static_cast<std::uint32_t>(value[0]) << 24)
      | (static_cast<std::uint32_t>(value[1]) << 16)
      | (static_cast<std::uint32_t>(value[2]) << 8)
      | static_cast<std::uint32_t>(value[3]);
}

std::uint16_t ReadBe16(const std::uint8_t* value) {
  return static_cast<std::uint16_t>(
      (static_cast<std::uint16_t>(value[0]) << 8)
      | static_cast<std::uint16_t>(value[1]));
}

void WriteBe32(std::vector<std::uint8_t>& output, std::size_t offset,
               std::uint32_t value) {
  output[offset] = static_cast<std::uint8_t>(value >> 24);
  output[offset + 1] = static_cast<std::uint8_t>(value >> 16);
  output[offset + 2] = static_cast<std::uint8_t>(value >> 8);
  output[offset + 3] = static_cast<std::uint8_t>(value);
}

std::vector<std::uint8_t> Packet(std::uint32_t operation,
                                 std::string_view body) {
  constexpr std::uint32_t header_size = 16;
  std::vector<std::uint8_t> output(header_size + body.size());
  WriteBe32(output, 0, static_cast<std::uint32_t>(output.size()));
  output[4] = 0;
  output[5] = 16;
  output[6] = 0;
  output[7] = 1;
  output[8] = 0;
  output[9] = 1;
  WriteBe32(output, 10, operation);
  output[14] = 0;
  output[15] = 1;
  std::copy(body.begin(), body.end(), output.begin() + header_size);
  return output;
}

std::string MaskCookie(std::string_view cookie) {
  return cookie.empty() ? std::string{} : std::string("********");
}

}  // namespace

struct BilibiliLiveRuntime::Impl {
  explicit Impl(SendText send_text) : send_text_(std::move(send_text)) {
    worker_ = std::thread([this] { FlushLoop(); });
  }

  ~Impl() { Close(); }

  ag99::runtime::DesktopSettingsResult HandleSetting(
      const ag99::runtime::DesktopSettingsQuery& query) {
    std::unique_lock lock(mutex_);
    if (query.action == "list") {
      if (query.key == "bilibili_live_enabled") {
        return BooleanResult(query, enabled_);
      }
      if (query.key == "bilibili_live_room_id") {
        return TextResult(query, room_id_);
      }
      if (query.key == "bilibili_live_cookie") {
        return TextResult(query, MaskCookie(cookie_));
      }
      if (query.key == "bilibili_live_response_interval") {
        return NumberResult(query, interval_seconds_, 5, 300, 1);
      }
      return Unsupported(query);
    }
    if (!query.value.has_value()) {
      return Invalid(query);
    }
    const auto previous_enabled = enabled_;
    const auto previous_room_id = room_id_;
    const auto previous_cookie = cookie_;
    if (query.key == "bilibili_live_enabled") {
      if (*query.value != "true" && *query.value != "false") {
        return Invalid(query);
      }
      enabled_ = *query.value == "true";
    } else if (query.key == "bilibili_live_room_id") {
      room_id_ = *query.value;
    } else if (query.key == "bilibili_live_cookie") {
      if (*query.value != "********" && !query.value->empty()) {
        cookie_ = *query.value;
      }
    } else if (query.key == "bilibili_live_response_interval") {
      try {
        const auto value = std::stoi(*query.value);
        if (value < 5 || value > 300) return OutOfRange(query);
        interval_seconds_ = value;
      } catch (...) {
        return Invalid(query);
      }
    } else {
      return Unsupported(query);
    }
    const bool should_start = enabled_ && !room_id_.empty();
    const bool should_stop = !enabled_ || previous_enabled != enabled_
        || previous_room_id != room_id_ || previous_cookie != cookie_;
    const bool enabled = enabled_;
    const auto room_id = room_id_;
    const auto cookie = cookie_;
    const auto interval_seconds = interval_seconds_;
    lock.unlock();
    if (should_stop) StopSocket();
    if (should_start) StartSocket();
    if (query.key == "bilibili_live_enabled") {
      return BooleanResult(query, enabled);
    }
    if (query.key == "bilibili_live_room_id") {
      return TextResult(query, room_id);
    }
    if (query.key == "bilibili_live_cookie") {
      return TextResult(query, MaskCookie(cookie));
    }
    return NumberResult(query, interval_seconds, 5, 300, 1);
  }

  void Close() {
    {
      std::scoped_lock lock(mutex_);
      closing_ = true;
    }
    condition_.notify_all();
    StopSocket();
    if (worker_.joinable()) worker_.join();
  }

private:
  static ag99::runtime::DesktopSettingsResult Unsupported(
      const ag99::runtime::DesktopSettingsQuery& query) {
    return {query.request_id, query.key, std::nullopt,
            "desktop_setting_unsupported"};
  }
  static ag99::runtime::DesktopSettingsResult Invalid(
      const ag99::runtime::DesktopSettingsQuery& query) {
    return {query.request_id, query.key, std::nullopt,
            "desktop_setting_value_invalid"};
  }
  static ag99::runtime::DesktopSettingsResult OutOfRange(
      const ag99::runtime::DesktopSettingsQuery& query) {
    return {query.request_id, query.key, std::nullopt,
            "desktop_setting_value_out_of_range"};
  }
  static ag99::runtime::DesktopSettingsResult TextResult(
      const ag99::runtime::DesktopSettingsQuery& query, std::string value) {
    return {query.request_id, query.key,
            ag99::runtime::DesktopSettingsEntry{std::move(value), {},
                                                std::nullopt, std::nullopt,
                                                std::nullopt}, {}};
  }
  static ag99::runtime::DesktopSettingsResult BooleanResult(
      const ag99::runtime::DesktopSettingsQuery& query, bool value) {
    return TextResult(query, value ? "true" : "false");
  }
  static ag99::runtime::DesktopSettingsResult NumberResult(
      const ag99::runtime::DesktopSettingsQuery& query, int value, double min,
      double max, double step) {
    return {query.request_id, query.key,
            ag99::runtime::DesktopSettingsEntry{
                std::to_string(value), {}, min, max, step}, {}};
  }

  void StartSocket() {
    std::string room_id;
    std::string cookie;
    {
      std::scoped_lock lock(mutex_);
      if (closing_ || !enabled_ || room_id_.empty() || socket_.connected()) {
        return;
      }
      room_id = room_id_;
      cookie = cookie_;
    }
    const auto info = ReadHttp(
        "api.live.bilibili.com",
        L"/room/v1/Room/get_info?room_id=" + Widen(room_id), cookie);
    std::int64_t real_room_id = 0;
    try {
      const auto data = Json::parse(info);
      real_room_id = data.at("data").at("room_id").get<std::int64_t>();
    } catch (...) {
      return;
    }
    std::string token;
    std::string host = kDefaultHost;
    try {
      const auto path = L"/xlive/web-room/v1/index/getDanmuInfo?id="
          + std::to_wstring(real_room_id) + L"&type=0";
      const auto data = Json::parse(ReadHttp(
          "api.live.bilibili.com", path, cookie));
      token = data.at("data").value("token", "");
      const auto& hosts = data.at("data").at("host_list");
      if (hosts.is_array() && !hosts.empty()) {
        host = hosts.at(0).value("host", host);
      }
    } catch (...) {
      // The default server still accepts the normal protocol for public rooms.
    }
    const auto generation = ++generation_;
    const auto callbacks = ag99::runtime::WebSocketCallbacks{
        [this, generation](std::string) {
          std::scoped_lock lock(mutex_);
          connected_ = generation == generation_;
        },
        [this, generation](std::vector<std::uint8_t> frame) {
          if (generation == generation_) HandleFrame(std::move(frame));
        },
        [this, generation](std::string) {
          std::scoped_lock lock(mutex_);
          if (generation == generation_) connected_ = false;
        },
        [this, generation] {
          std::scoped_lock lock(mutex_);
          if (generation == generation_) connected_ = false;
        }};
    if (!socket_.connect("wss://" + host + ":443/sub", callbacks)) return;
    const Json auth = {
        {"uid", 0}, {"roomid", real_room_id}, {"protover", 0},
        {"platform", "web"}, {"type", 2}, {"key", token}};
    socket_.send_binary(Packet(7, auth.dump()));
    {
      std::scoped_lock lock(mutex_);
      connected_ = true;
      real_room_id_ = real_room_id;
    }
  }

  void StopSocket() {
    ++generation_;
    socket_.close();
    std::scoped_lock lock(mutex_);
    connected_ = false;
    real_room_id_ = 0;
  }

  void HandleFrame(std::vector<std::uint8_t> frame) {
    std::size_t offset = 0;
    while (offset + 16 <= frame.size()) {
      const auto length = ReadBe32(frame.data() + offset);
      const auto header = static_cast<std::size_t>(
          (frame[offset + 4] << 8) | frame[offset + 5]);
      const auto protocol_version = ReadBe16(frame.data() + offset + 6);
      const auto operation = ReadBe32(frame.data() + offset + 10);
      if (length < 16 || header < 16 || length < header
          || offset + length > frame.size()) {
        return;
      }
      // Native auth requests protocol version 0, so the server returns the
      // uncompressed JSON form (header versions 0 or 1). Compressed v2/v3
      // packets are intentionally ignored until a native decompressor is
      // added; they must never be mistaken for JSON.
      if (operation == 5 && protocol_version <= 1) {
        const std::string body(
            reinterpret_cast<const char*>(frame.data() + offset + header),
            length - header);
        try {
          const auto message = Json::parse(body);
          if (message.value("cmd", "") == "DANMU_MSG") {
            const auto& info = message.at("info");
            const auto text = info.at(1).get<std::string>();
            const auto uid = info.at(2).at(0).get<std::int64_t>();
            const auto name = info.at(2).at(1).get<std::string>();
            std::scoped_lock lock(mutex_);
            if (!text.empty()) {
              if (pending_.size() >= kMaxBufferSize) {
                pending_.erase(pending_.begin());
              }
              pending_.push_back("- " + name + "（UID "
                  + std::to_string(uid) + "）：" + text.substr(0, 180));
            }
          }
        } catch (...) {
        }
      }
      offset += length;
    }
  }

  void FlushLoop() {
    auto last_flush = std::chrono::steady_clock::now();
    auto last_heartbeat = last_flush;
    while (true) {
      std::unique_lock lock(mutex_);
      condition_.wait_for(lock, std::chrono::seconds(1), [this] {
        return closing_;
      });
      if (closing_) return;
      const auto now = std::chrono::steady_clock::now();
      const bool send_heartbeat = connected_
          && now - last_heartbeat >= std::chrono::seconds(30);
      if (send_heartbeat) {
        last_heartbeat = now;
      }
      if (!enabled_ || pending_.empty()
          || now - last_flush < std::chrono::seconds(interval_seconds_)) {
        lock.unlock();
        if (send_heartbeat) {
          socket_.send_binary(Packet(2, "[object Object]"));
        }
        continue;
      }
      const auto batch_size = std::min(kMaxBatchSize, pending_.size());
      std::vector<std::string> batch;
      batch.reserve(batch_size);
      for (std::size_t index = 0; index < batch_size; ++index) {
        batch.push_back(std::move(pending_[index]));
      }
      pending_.erase(pending_.begin(), pending_.begin() + batch_size);
      last_flush = now;
      lock.unlock();
      if (send_heartbeat) {
        socket_.send_binary(Packet(2, "[object Object]"));
      }
      std::ostringstream text;
      text << "[直播弹幕输入]\n直播间观众刚刚说：\n";
      for (const auto& item : batch) text << item << '\n';
      text << "\n请自然回应适合互动的内容，保持简短。";
      const auto sent = send_text_ && send_text_(text.str());
      if (!sent) {
        std::scoped_lock retry_lock(mutex_);
        pending_.insert(
            pending_.begin(),
            std::make_move_iterator(batch.begin()),
            std::make_move_iterator(batch.end()));
        if (pending_.size() > kMaxBufferSize) {
          pending_.erase(
              pending_.begin() + kMaxBufferSize, pending_.end());
        }
      }
    }
  }

  SendText send_text_;
  ag99::runtime::WinHttpWebSocketClient socket_;
  std::mutex mutex_;
  std::condition_variable condition_;
  std::thread worker_;
  std::vector<std::string> pending_;
  std::string room_id_;
  std::string cookie_;
  int interval_seconds_ = 30;
  std::int64_t real_room_id_ = 0;
  std::atomic<std::uint64_t> generation_{0};
  bool enabled_ = false;
  bool connected_ = false;
  bool closing_ = false;
};

BilibiliLiveRuntime::BilibiliLiveRuntime(SendText send_text)
    : impl_(std::make_unique<Impl>(std::move(send_text))) {}
BilibiliLiveRuntime::~BilibiliLiveRuntime() = default;
ag99::runtime::DesktopSettingsResult BilibiliLiveRuntime::HandleSetting(
    const ag99::runtime::DesktopSettingsQuery& query) {
  return impl_->HandleSetting(query);
}
void BilibiliLiveRuntime::Close() { impl_->Close(); }

}  // namespace ag99::native
