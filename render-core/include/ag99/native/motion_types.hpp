#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include "ag99/native/runtime_coordinator.hpp"

namespace ag99::native {

struct MotionTrack {
  struct Keyframe {
    int at_ms = 0;
    float target_value = 0.0f;
  };

  std::int32_t parameter_index = -1;
  float neutral_value = 0.0f;
  int start_at_ms = 0;
  std::vector<Keyframe> keyframes;
};

struct MotionPlan {
  double started_at = 0.0;
  int duration_ms = 900;
  int blend_in_ms = 120;
  int blend_out_ms = 180;
  std::vector<MotionTrack> tracks;
  NativeSegmentClock clock;
};

struct ParameterPlanTrackPoint {
  int at_ms = 0;
  int transition_ms = 0;
  float value = 0.0f;
};

struct ParameterPresentationState {
  float initial_value = 0.0f;
  float neutral_value = 0.0f;
  float max_velocity = 1.0f;
  float max_acceleration = 1.0f;
  std::string response_kind = "bounded";
  float response_frequency_hz = 0.0f;
  float response_damping_ratio = 0.0f;
  float driven_offset = 0.0f;
  float velocity = 0.0f;
  double last_elapsed_ms = -1.0;
};

struct ParameterPlanBinding {
  std::string axis_id;
  std::string parameter_id;
  std::int32_t parameter_index = -1;
  int activation_at_ms = 0;
  float target_value = 0.0f;
  float neutral_target_value = 0.0f;
  float weight = 1.0f;
  std::vector<ParameterPlanTrackPoint> keyframes;
  std::vector<ParameterPlanTrackPoint> modulation_points;
  float modulation_amplitude = 0.0f;
  int modulation_direction = 1;
  int modulation_delay_ms = 0;
  float max_speech_offset = 0.0f;
  ParameterPresentationState presentation;
};

struct InteractionBinding {
  std::string axis_id;
  std::string parameter_id;
  std::int32_t parameter_index = -1;
  float neutral_value = 0.0f;
  float negative_value = 0.0f;
  float positive_value = 0.0f;
  float weight = 1.0f;
  ParameterPresentationState presentation;
};

struct InteractionSwayState {
  std::string turn_id;
  double cycle_ms = 4000.0;
  double attack_ms = 500.0;
  double release_ms = 650.0;
  double elapsed_ms = 0.0;
  std::optional<double> release_started_at_ms;
  std::vector<InteractionBinding> bindings;
};

struct InteractionGazeState {
  double target_ratio = 0.0;
  double elapsed_ms = 0.0;
  std::vector<InteractionBinding> bindings;
};

struct ParameterPlan {
  double started_at = 0.0;
  int duration_ms = 0;
  int blend_in_ms = 0;
  int hold_ms = 0;
  int blend_out_ms = 0;
  std::string curve_preset = "smooth_hold";
  std::string expression_id;
  NativeSegmentClock clock;
  double release_started_at_ms = -1.0;
  std::vector<ParameterPlanBinding> bindings;
};

}  // namespace ag99::native
