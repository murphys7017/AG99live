#pragma once

#include <atomic>
#include <string_view>

namespace ag99::audio {

class SpeechSignalRuntime final {
public:
  void Update(float audio_level, float delta_seconds);

  float LipSyncIntensity() const;
  float AudioGain(std::string_view axis_id) const;

  void Reset();

private:
  std::atomic<float> lip_sync_intensity_{0.0f};
  std::atomic<float> speech_energy_input_{0.0f};
  std::atomic<float> speech_head_envelope_{0.0f};
  std::atomic<float> speech_body_envelope_{0.0f};
  std::atomic<float> speech_emphasis_envelope_{0.0f};
  std::atomic<bool> speech_voiced_{false};
};

}  // namespace ag99::audio
