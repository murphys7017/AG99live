#include <algorithm>
#include <cmath>

#include "ag99/native/motion_scheduler.hpp"

namespace ag99::native::motion {

float ResolveTrack(
    const std::vector<ParameterPlanTrackPoint>& points,
    double elapsed_ms,
    float fallback) {
  if (points.size() < 2) {
    return fallback;
  }
  auto previous = points.front();
  for (std::size_t index = 1; index < points.size(); ++index) {
    const auto next = points[index];
    if (elapsed_ms < next.at_ms) {
      return previous.value;
    }
    const auto transition_end = next.at_ms + next.transition_ms;
    if (next.transition_ms > 0 && elapsed_ms < transition_end) {
      const auto t = static_cast<float>(
          std::clamp(
              (elapsed_ms - next.at_ms) / next.transition_ms,
              0.0,
              1.0));
      return previous.value + (next.value - previous.value) * t;
    }
    previous = next;
  }
  return previous.value;
}

float ClampFloat(float value, float minimum, float maximum) {
  return std::max(minimum, std::min(maximum, value));
}

DynamicsState AdvanceBounded(
    float previous,
    float target,
    float velocity,
    float delta_seconds,
    float max_velocity,
    float max_acceleration) {
  const float remaining = target - previous;
  const float velocity_delta = max_acceleration * delta_seconds;
  if (std::abs(remaining) <= 0.001f
      && std::abs(velocity) <= velocity_delta) {
    return {target, 0.0f};
  }
  const float direction = remaining == 0.0f
      ? 0.0f : remaining > 0 ? 1.0f : -1.0f;
  const float braking_speed = std::sqrt(
      std::max(0.0f, 2.0f * max_acceleration * std::abs(remaining)));
  const float desired_velocity = direction
      * std::min(max_velocity, braking_speed);
  const float next_velocity = ClampFloat(
      desired_velocity,
      velocity - velocity_delta,
      velocity + velocity_delta);
  const float next_value = previous + next_velocity * delta_seconds;
  if (direction != 0.0f
      && ((target - next_value > 0) != (direction > 0))) {
    return {target, 0.0f};
  }
  if (std::abs(target - next_value) <= 0.001f
      && std::abs(next_velocity) <= velocity_delta) {
    return {target, 0.0f};
  }
  return {next_value, next_velocity};
}

float ResolveDampedSpringVelocity(
    float previous,
    float target,
    float velocity,
    float delta_seconds,
    float frequency_hz,
    float damping_ratio) {
  const float displacement = previous - target;
  const float angular_frequency =
      2.0f * 3.14159265358979323846f * frequency_hz;
  const float damped_frequency = angular_frequency
      * std::sqrt(std::max(0.0f, 1.0f - damping_ratio * damping_ratio));
  if (damped_frequency <= 1e-6f) {
    return 0.0f;
  }
  const float decay = std::exp(
      -damping_ratio * angular_frequency * delta_seconds);
  const float phase = damped_frequency * delta_seconds;
  const float cosine = std::cos(phase);
  const float sine = std::sin(phase);
  const float velocity_term =
      (velocity + damping_ratio * angular_frequency * displacement)
      / damped_frequency;
  const float projected_displacement =
      displacement * cosine + velocity_term * sine;
  return decay * (
      -damping_ratio * angular_frequency * projected_displacement
      - displacement * damped_frequency * sine
      + velocity_term * damped_frequency * cosine);
}

DynamicsState AdvanceSpringStep(
    float previous,
    float target,
    float velocity,
    float delta_seconds,
    float max_velocity,
    float max_acceleration,
    float frequency_hz,
    float damping_ratio) {
  const float remaining = target - previous;
  const float velocity_delta = max_acceleration * delta_seconds;
  if (std::abs(remaining) <= 0.001f
      && std::abs(velocity) <= velocity_delta) {
    return {target, 0.0f};
  }
  const float desired_velocity = ResolveDampedSpringVelocity(
      previous,
      target,
      velocity,
      delta_seconds,
      frequency_hz,
      damping_ratio);
  const float acceleration_limited_velocity = ClampFloat(
      desired_velocity,
      velocity - velocity_delta,
      velocity + velocity_delta);
  const float next_velocity = ClampFloat(
      acceleration_limited_velocity,
      -max_velocity,
      max_velocity);
  const float next_value = previous + next_velocity * delta_seconds;
  if (std::abs(target - next_value) <= 0.001f
      && std::abs(next_velocity) <= velocity_delta) {
    return {target, 0.0f};
  }
  return {next_value, next_velocity};
}

DynamicsState AdvanceSpring(
    float previous,
    float target,
    float velocity,
    float delta_seconds,
    float max_velocity,
    float max_acceleration,
    float frequency_hz,
    float damping_ratio) {
  const int steps = std::max(
      1, static_cast<int>(std::ceil(delta_seconds / (1.0f / 120.0f))));
  const float step_seconds = delta_seconds / steps;
  float value = previous;
  float current_velocity = velocity;
  for (int index = 0; index < steps; ++index) {
    const auto state = AdvanceSpringStep(
        value,
        target,
        current_velocity,
        step_seconds,
        max_velocity,
        max_acceleration,
        frequency_hz,
        damping_ratio);
    value = state.value;
    current_velocity = state.velocity;
  }
  return {value, current_velocity};
}

double EvaluateTrackValue(
    const MotionPlan& plan,
    const MotionTrack& track,
    double elapsed_ms) {
  if (track.keyframes.empty() || elapsed_ms < track.start_at_ms) {
    return track.neutral_value;
  }
  const double track_start_ms = track.start_at_ms;
  const double track_blend_out_start_ms = std::max(
      track_start_ms,
      static_cast<double>(plan.duration_ms - plan.blend_out_ms));
  const double next_keyframe_ms = track.keyframes.size() > 1
      ? static_cast<double>(track.keyframes[1].at_ms)
      : static_cast<double>(plan.duration_ms);
  const double blend_in_end_ms = std::min({
      track_start_ms + static_cast<double>(plan.blend_in_ms),
      next_keyframe_ms,
      track_blend_out_start_ms,
      static_cast<double>(plan.duration_ms)});
  double value = track.neutral_value;
  if (elapsed_ms < blend_in_end_ms) {
    const double t = std::clamp(
        (elapsed_ms - track_start_ms)
            / std::max(1.0, blend_in_end_ms - track_start_ms),
        0.0,
        1.0);
    const double smooth = t * t * (3.0 - 2.0 * t);
    value = track.neutral_value
        + (track.keyframes.front().target_value - track.neutral_value)
            * smooth;
  } else {
    value = track.keyframes.back().target_value;
    for (std::size_t index = 1; index < track.keyframes.size(); ++index) {
      const auto& previous = track.keyframes[index - 1];
      const auto& next = track.keyframes[index];
      if (elapsed_ms < next.at_ms) {
        const double previous_at_ms = index == 1
            ? std::max(
                  static_cast<double>(previous.at_ms),
                  blend_in_end_ms)
            : static_cast<double>(previous.at_ms);
        const double window = std::max(
            1.0,
            static_cast<double>(next.at_ms) - previous_at_ms);
        const double t = std::clamp(
            (elapsed_ms - previous_at_ms) / window,
            0.0,
            1.0);
        const double smooth = t * t * (3.0 - 2.0 * t);
        value = previous.target_value
            + (next.target_value - previous.target_value) * smooth;
        break;
      }
    }
    if (elapsed_ms >= track_blend_out_start_ms) {
      const double t = std::clamp(
          (elapsed_ms - track_blend_out_start_ms)
              / std::max(
                  1.0,
                  static_cast<double>(plan.duration_ms)
                      - track_blend_out_start_ms),
          0.0,
          1.0);
      const double smooth = t * t * (3.0 - 2.0 * t);
      value += (track.neutral_value - value) * smooth;
    }
  }
  return value;
}

}  // namespace ag99::native::motion
