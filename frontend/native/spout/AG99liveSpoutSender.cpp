#include <windows.h>

#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

#include "SpoutLibrary.h"

namespace {

constexpr std::uint32_t kFrameMagic = 0x41473939;
constexpr std::uint32_t kMaxFrameDimension = 8192;
constexpr std::size_t kMaxFrameBytes = 256U * 1024U * 1024U;
constexpr char kDefaultSenderName[] = "AG99live.Live2D";

struct FrameHeader {
  std::uint32_t magic;
  std::uint32_t width;
  std::uint32_t height;
  std::uint32_t byte_length;
};

static_assert(sizeof(FrameHeader) == 16);

using GetSpoutProc = SPOUTHANDLE(WINAPI*)(void);

bool ReadExact(HANDLE input, void* destination, std::size_t byte_length) {
  auto* cursor = static_cast<std::uint8_t*>(destination);
  std::size_t remaining = byte_length;
  while (remaining > 0) {
    const DWORD request = static_cast<DWORD>(remaining > MAXDWORD ? MAXDWORD : remaining);
    DWORD received = 0;
    if (!ReadFile(input, cursor, request, &received, nullptr) || received == 0) {
      return false;
    }
    cursor += received;
    remaining -= received;
  }
  return true;
}

void WriteStatus(const char* status, FILE* stream = stdout) {
  std::fputs(status, stream);
  std::fputc('\n', stream);
  std::fflush(stream);
}

bool IsValidHeader(const FrameHeader& header) {
  if (
    header.magic != kFrameMagic
    || header.width == 0
    || header.height == 0
    || header.width > kMaxFrameDimension
    || header.height > kMaxFrameDimension
  ) {
    return false;
  }
  const std::uint64_t required_bytes =
    static_cast<std::uint64_t>(header.width) * static_cast<std::uint64_t>(header.height) * 4U;
  return required_bytes <= kMaxFrameBytes && required_bytes == header.byte_length;
}

} // namespace

int main(int argc, char** argv) {
  const char* sender_name = kDefaultSenderName;
  if (argc == 3 && std::string(argv[1]) == "--sender" && argv[2][0] != '\0') {
    sender_name = argv[2];
  }

  const HMODULE module = LoadLibraryA("SpoutLibrary.dll");
  if (!module) {
    WriteStatus("spout_library_load_failed", stderr);
    return 1;
  }

  const auto get_spout = reinterpret_cast<GetSpoutProc>(GetProcAddress(module, "GetSpout"));
  if (!get_spout) {
    WriteStatus("spout_factory_missing", stderr);
    FreeLibrary(module);
    return 1;
  }

  SPOUTHANDLE spout = get_spout();
  if (!spout) {
    WriteStatus("spout_factory_failed", stderr);
    FreeLibrary(module);
    return 1;
  }

  spout->SetSenderName(sender_name);
  if (!spout->CreateOpenGL()) {
    WriteStatus("spout_opengl_context_failed", stderr);
    spout->Release();
    FreeLibrary(module);
    return 1;
  }

  WriteStatus("ready");
  const HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
  std::vector<std::uint8_t> pixels;
  FrameHeader header{};
  while (ReadExact(input, &header, sizeof(header))) {
    if (!IsValidHeader(header)) {
      WriteStatus("spout_frame_header_invalid", stderr);
      break;
    }

    pixels.resize(header.byte_length);
    if (!ReadExact(input, pixels.data(), pixels.size())) {
      WriteStatus("spout_frame_incomplete", stderr);
      break;
    }

    if (!spout->SendImage(pixels.data(), header.width, header.height, GL_RGBA, false)) {
      WriteStatus("spout_frame_send_failed", stderr);
    }
  }

  spout->ReleaseSender();
  spout->CloseOpenGL();
  spout->Release();
  FreeLibrary(module);
  return 0;
}
