#pragma once

#include <optional>
#include <functional>
#include <string>
#include <string_view>
#include <unordered_map>

#include "ag99/native/motion_types.hpp"
#include "ag99/runtime/protocol.hpp"

namespace ag99::native::motion {

struct AxisDefinition {
  double neutral = 0.0;
  double value_min = 0.0;
  double value_max = 100.0;
  double strong_min = 0.0;
  double strong_max = 100.0;
  std::string group;
};

struct AxisValue {
  double value = 0.0;
  double neutral = 0.0;
  std::string group;
};

using AxisMap = std::unordered_map<std::string, AxisValue>;

struct AxisResolution {
  AxisMap values;
  bool invalid_axis_value = false;
};

struct MotionCompileContext {
  const ag99::runtime::Json* profile = nullptr;
  double intensity_scale = 1.0;
  std::function<std::int32_t(std::string_view)> resolve_parameter_index;
};

struct ParameterBindingContext {
  std::int32_t index = -1;
  float minimum = 0.0f;
  float maximum = 0.0f;
  float current = 0.0f;
};

struct ParameterPlanContext {
  const ag99::runtime::Json* profile = nullptr;
  std::function<std::optional<ParameterBindingContext>(std::string_view)>
      resolve_parameter;
};

std::optional<ParameterPlanTrackPoint> ParseTrackPoint(
    const ag99::runtime::Json& value,
    int duration_ms,
    bool modulation);

AxisResolution ResolveAxisValues(
    const ag99::runtime::Json& profile,
    const ag99::runtime::Json& values,
    bool expressive,
    double intensity_scale);

std::optional<MotionPlan> CompileMotionPlan(
    const ag99::runtime::OutputSegment& segment,
    const NativeSegmentClock& clock,
    const MotionCompileContext& context);

std::optional<ParameterPlan> ParseParameterPlan(
    const ag99::runtime::OutputSegment& segment,
    const NativeSegmentClock& clock,
    const ParameterPlanContext& context);

}  // namespace ag99::native::motion
