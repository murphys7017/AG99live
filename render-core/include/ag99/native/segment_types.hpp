#pragma once

#include <cstdint>
#include <string>

namespace ag99::native {

// Render-host metadata shared by audio, motion and playback coordination.
// It is intentionally outside the wire protocol: the Adapter owns protocol
// identities while the native runtime owns local playback timing.
struct NativeSegmentClock {
  std::string turn_id;
  std::string message_id;
  std::int64_t sequence = 0;
  double started_at_seconds = 0.0;
  double duration_seconds = 0.0;
  std::uint64_t audio_serial = 0;
  std::uint64_t generation = 0;
};

struct NativeSegmentTerminal {
  NativeSegmentClock clock;
  bool success = false;
  std::string reason;
};

}  // namespace ag99::native
