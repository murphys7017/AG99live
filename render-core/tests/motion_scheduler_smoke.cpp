#ifdef NDEBUG
#undef NDEBUG
#endif
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
  auto bound_profile = profile;
  bound_profile["axes"][0]["parameter_bindings"] = ag99::runtime::Json::array({
      {{"parameter_id", "ParamAngleY"}, {"input_range", {0, 100}}, {"output_range", {-30, 30}}}});
  ag99::runtime::OutputSegment segment;
  segment.motion.state = ag99::runtime::MotionSlot::State::Present;
  auto& intent = segment.motion.payload;
  intent["schema_version"] = "engine.motion_intent.v4";
  intent["duration_hint_ms"] = 15000;
  auto& steps = intent["motion_steps"] = ag99::runtime::Json::array();
  for (int i = 0; i < 8; ++i) {
    steps.push_back({{"axis_values", {{"head_pitch", 51 + i}}}, {"duration_weight", 1}});
  }
  const ag99::native::motion::MotionCompileContext context{
      &bound_profile, 1.0, [](std::string_view) { return 0; }};
  const auto long_plan = ag99::native::motion::CompileMotionPlan(segment, {}, context);
  if (!long_plan || long_plan->duration_ms != 15000 || long_plan->tracks.size() != 1
      || long_plan->tracks.front().keyframes.size() != 8
      || long_plan->tracks.front().keyframes.back().target_value < 4.79f) {
    return 1;
  }
  steps.push_back(steps.front());
  if (ag99::native::motion::CompileMotionPlan(segment, {}, context)) {
    return 1;
  }

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
