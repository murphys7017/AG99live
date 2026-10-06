#include "ag99/audio/speech_signal.hpp"

#include <algorithm>
#include <cmath>

namespace ag99::audio {

namespace {

constexpr float kSpeechHeadAttack = 10.0f;
constexpr float kSpeechHeadRelease = 3.4f;
constexpr float kSpeechBodyAttack = 5.5f;
constexpr float kSpeechBodyRelease = 2.4f;
constexpr float kSpeechHeadActivityFloor = 0.42f;
constexpr float kSpeechHeadGainSpan = 1.32f;
constexpr float kSpeechHeadGainMax = 1.68f;
constexpr float kSpeechPitchGainMax = 1.25f;
constexpr float kSpeechBodyActivityFloor = 0.34f;
constexpr float kSpeechBodyGainSpan = 1.0f;
constexpr float kSpeechBodyGainMax = 1.18f;
constexpr float kSpeechVoicedEnter = 0.028f;
constexpr float kSpeechVoicedExit = 0.012f;
constexpr float kSpeechEmphasisRiseThreshold = 1.5f;
constexpr float kSpeechEmphasisRiseGain = 0.09f;
constexpr float kSpeechEmphasisAttack = 18.0f;
constexpr float kSpeechEmphasisRelease = 7.0f;
constexpr float kSpeechEmphasisMax = 0.42f;

float AdvanceSpeechEnvelope(
    float current,
    float target,
    float delta_seconds,
    float attack_per_second,
    float release_per_second) {
  const auto rate = target > current ? attack_per_second : release_per_second;
  const auto blend = 1.0f - std::exp(
      -std::max(0.0f, delta_seconds) * rate);
  return current + (target - current) * blend;
}

}  // namespace

void SpeechSignalRuntime::Update(float audio_level, float delta_seconds) {
  lip_sync_intensity_.store(std::clamp(
      (audio_level - 0.012f) * 30.0f, 0.0f, 1.0f));
  speech_energy_input_.store(std::clamp(
      (audio_level - 0.008f) * 5.5f, 0.0f, 1.0f));

  const float speech_energy = speech_energy_input_.load();
  const bool was_voiced = speech_voiced_.load();
  const bool voiced = speech_energy >= (was_voiced
      ? kSpeechVoicedExit : kSpeechVoicedEnter);
  speech_voiced_.store(voiced);
  const float target_energy = voiced ? speech_energy : 0.0f;
  const float previous_head = speech_head_envelope_.load();
  const float head = AdvanceSpeechEnvelope(
      previous_head,
      target_energy,
      delta_seconds,
      kSpeechHeadAttack,
      kSpeechHeadRelease);
  const float body = AdvanceSpeechEnvelope(
      speech_body_envelope_.load(),
      target_energy,
      delta_seconds,
      kSpeechBodyAttack,
      kSpeechBodyRelease);
  const float positive_rise = delta_seconds > 0.0f
      ? std::max(0.0f, head - previous_head) / delta_seconds
      : 0.0f;
  const float emphasis_target = voiced
      ? std::clamp(
          (positive_rise - kSpeechEmphasisRiseThreshold)
              * kSpeechEmphasisRiseGain,
          0.0f,
          kSpeechEmphasisMax)
      : 0.0f;
  const float emphasis = AdvanceSpeechEnvelope(
      speech_emphasis_envelope_.load(),
      emphasis_target,
      delta_seconds,
      kSpeechEmphasisAttack,
      kSpeechEmphasisRelease);
  speech_head_envelope_.store(head < 0.001f ? 0.0f : head);
  speech_body_envelope_.store(body < 0.001f ? 0.0f : body);
  speech_emphasis_envelope_.store(emphasis < 0.001f ? 0.0f : emphasis);
}

float SpeechSignalRuntime::LipSyncIntensity() const {
  return lip_sync_intensity_.load();
}

float SpeechSignalRuntime::AudioGain(std::string_view axis_id) const {
  const auto channel_name = axis_id.starts_with("voice_following.")
      ? axis_id.substr(std::string_view("voice_following.").size())
      : axis_id;
  const auto separator = channel_name.find('|');
  const auto channel = channel_name.substr(0, separator);
  const bool body = channel.starts_with("body_");
  const auto voiced = speech_voiced_.load();
  const auto activity_floor = voiced
      ? (body ? kSpeechBodyActivityFloor : kSpeechHeadActivityFloor)
      : 0.0f;
  const auto raw_gain = body
      ? std::min(
          kSpeechBodyGainMax,
          activity_floor
              + speech_body_envelope_.load() * kSpeechBodyGainSpan
              + speech_emphasis_envelope_.load() * 0.24f)
      : std::min(
          kSpeechHeadGainMax,
          activity_floor
              + speech_head_envelope_.load() * kSpeechHeadGainSpan
              + speech_emphasis_envelope_.load() * 0.38f);
  return channel.find("pitch") != std::string_view::npos
      ? std::min(kSpeechPitchGainMax, raw_gain)
      : raw_gain;
}

void SpeechSignalRuntime::Reset() {
  speech_head_envelope_.store(0.0f);
  speech_body_envelope_.store(0.0f);
  speech_emphasis_envelope_.store(0.0f);
  speech_voiced_.store(false);
  lip_sync_intensity_.store(0.0f);
  speech_energy_input_.store(0.0f);
}

}  // namespace ag99::audio
