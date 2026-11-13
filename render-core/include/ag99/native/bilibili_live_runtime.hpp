#pragma once

#include <functional>
#include <memory>
#include <string>

#include "ag99/runtime/protocol.hpp"

namespace ag99::native {

class BilibiliLiveRuntime final {
public:
  using SendText = std::function<bool(std::string)>;

  explicit BilibiliLiveRuntime(SendText send_text);
  ~BilibiliLiveRuntime();

  BilibiliLiveRuntime(const BilibiliLiveRuntime&) = delete;
  BilibiliLiveRuntime& operator=(const BilibiliLiveRuntime&) = delete;

  ag99::runtime::DesktopSettingsResult HandleSetting(
      const ag99::runtime::DesktopSettingsQuery& query);
  void Close();

private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace ag99::native
