#pragma once

#include <string>
#include <deque>
#include <optional>
#include <vector>

#include "ag99/native/motion_types.hpp"
#include "ag99/runtime/protocol.hpp"

namespace ag99::native::motion {

struct MotionScheduler {
  std::optional<MotionPlan> active_motion;
  std::optional<ag99::runtime::OutputSegment> pending_motion_segment;
  std::optional<NativeSegmentClock> pending_motion_clock;
  std::deque<NativeSegmentTerminal> segment_terminals;
};

float ResolveTrack(
    const std::vector<ParameterPlanTrackPoint>& points,
    double elapsed_ms,
    float fallback);

float ClampFloat(float value, float minimum, float maximum);

struct DynamicsState {
  float value = 0.0f;
  float velocity = 0.0f;
};

DynamicsState AdvanceBounded(
    float previous,
    float target,
    float velocity,
    float delta_seconds,
    float max_velocity,
    float max_acceleration);

float ResolveDampedSpringVelocity(
    float previous,
    float target,
    float velocity,
    float delta_seconds,
    float frequency_hz,
    float damping_ratio);

DynamicsState AdvanceSpringStep(
    float previous,
    float target,
    float velocity,
    float delta_seconds,
    float max_velocity,
    float max_acceleration,
    float frequency_hz,
    float damping_ratio);

DynamicsState AdvanceSpring(
    float previous,
    float target,
    float velocity,
    float delta_seconds,
    float max_velocity,
    float max_acceleration,
    float frequency_hz,
    float damping_ratio);

double EvaluateTrackValue(
    const MotionPlan& plan,
    const MotionTrack& track,
    double elapsed_ms);

}  // namespace ag99::native::motion
