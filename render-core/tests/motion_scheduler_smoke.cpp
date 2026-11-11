#include <cassert>
#include <cmath>

#include "ag99/native/motion_compiler.hpp"
#include "ag99/native/motion_scheduler.hpp"

int main() {
  const auto valid = ag99::runtime::Json{
      {"at_ms", 0},
      {"transition_ms", 0},
      {"target_value", 0.25},
      {"input_value", 0.0},
  };
  const auto point = ag99::native::motion::ParseTrackPoint(
      valid, 900, false);
  assert(point.has_value());
  assert(std::abs(point->value - 0.25f) < 1e-6f);

  const auto invalid = ag99::runtime::Json{
      {"at_ms", 901},
      {"transition_ms", 0},
      {"target_value", 0.25},
      {"input_value", 0.0},
  };
  assert(!ag99::native::motion::ParseTrackPoint(invalid, 900, false));

  const auto profile = ag99::runtime::Json{
      {"axes", ag99::runtime::Json::array({
          {
              {"id", "head_pitch"},
              {"neutral", 50.0},
              {"value_range", ag99::runtime::Json::array({0.0, 100.0})},
              {"strong_range", ag99::runtime::Json::array({20.0, 80.0})},
              {"control_role", "primary"},
              {"semantic_group", "head"},
          },
      })},
      {"relation_graph", {"edges", ag99::runtime::Json::array()}},
  };
  const auto resolution = ag99::native::motion::ResolveAxisValues(
      profile,
      ag99::runtime::Json{{"head_pitch", 60.0}},
      false,
      1.35);
  assert(!resolution.invalid_axis_value);
  assert(resolution.values.contains("head_pitch"));
  assert(std::abs(resolution.values.at("head_pitch").value - 60.0) < 1e-6);

  const std::vector<ag99::native::ParameterPlanTrackPoint> points = {
      {0, 0, 0.0f},
      {100, 100, 1.0f},
  };
  const auto interpolated = ag99::native::motion::ResolveTrack(
      points, 150.0, -1.0f);
  assert(interpolated > 0.49f && interpolated < 0.51f);

  const auto spring = ag99::native::motion::AdvanceSpring(
      0.0f, 1.0f, 0.0f, 1.0f, 2.0f, 10.0f, 2.0f, 0.7f);
  assert(std::isfinite(spring.value));
  assert(std::isfinite(spring.velocity));
  assert(spring.value >= -0.01f && spring.value <= 1.01f);
  return 0;
}
