#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <iostream>
#include <unordered_set>
#include <utility>

#include "ag99/native/json_utils.hpp"
#include "ag99/native/motion_compiler.hpp"

namespace ag99::native::motion {

std::optional<ParameterPlanTrackPoint> ParseTrackPoint(
    const ag99::runtime::Json& value,
    int duration_ms,
    bool modulation) {
  const bool valid_shape = modulation
      ? json::HasOnlyKeys(value, {"at_ms", "transition_ms", "value"})
      : json::HasOnlyKeys(
          value,
          {"at_ms", "transition_ms", "target_value", "input_value"});
  if (!value.is_object() || !valid_shape) {
    return std::nullopt;
  }
  const auto at = value.find("at_ms");
  const auto transition = value.find("transition_ms");
  const char* value_key = modulation ? "value" : "target_value";
  const auto target = value.find(value_key);
  if (at == value.end() || transition == value.end() || target == value.end()
      || !json::IsIntegerInRange(*at, 0, duration_ms)
      || !json::IsIntegerInRange(*transition, 0, duration_ms)
      || !json::IsFiniteNumber(*target)) {
    return std::nullopt;
  }
  const auto at_ms = static_cast<int>(at->get<std::int64_t>());
  const auto transition_ms = static_cast<int>(
      transition->get<std::int64_t>());
  if (at_ms + transition_ms > duration_ms) {
    return std::nullopt;
  }
  return ParameterPlanTrackPoint{
      at_ms,
      transition_ms,
      static_cast<float>(target->get<double>())};
}

AxisResolution ResolveAxisValues(
    const ag99::runtime::Json& profile,
    const ag99::runtime::Json& values,
    bool expressive,
    double intensity_scale) {
  AxisResolution resolution;
  const auto axes = profile.find("axes");
  if (axes == profile.end() || !axes->is_array()) {
    return resolution;
  }

  const auto read_range = [](const ag99::runtime::Json& axis,
                             const char* key,
                             double fallback_min,
                             double fallback_max) {
    std::array<double, 2> result{fallback_min, fallback_max};
    const auto range = axis.find(key);
    if (range != axis.end() && range->is_array() && range->size() == 2
        && (*range)[0].is_number() && (*range)[1].is_number()) {
      result[0] = (*range)[0].get<double>();
      result[1] = (*range)[1].get<double>();
    }
    return result;
  };

  std::unordered_map<std::string, AxisDefinition> definitions;
  for (const auto& axis : *axes) {
    if (!axis.is_object()) {
      continue;
    }
    const auto id = json::ReadString(axis, "id");
    if (id.empty()) {
      continue;
    }
    const auto value_range = read_range(axis, "value_range", 0.0, 100.0);
    const auto strong_range = read_range(
        axis, "strong_range", value_range[0], value_range[1]);
    definitions.emplace(
        id,
        AxisDefinition{
            json::ReadNumber(axis, "neutral", 50.0),
            value_range[0],
            value_range[1],
            strong_range[0],
            strong_range[1],
            json::ReadString(axis, "semantic_group")});
  }

  if (!values.is_object()) {
    return resolution;
  }
  std::unordered_set<std::string> explicit_axes;
  for (const auto& axis : *axes) {
    if (!axis.is_object()) {
      continue;
    }
    const auto id = json::ReadString(axis, "id");
    const auto value_it = values.find(id);
    if (id.empty() || value_it == values.end() || !value_it->is_number()) {
      continue;
    }
    const auto role = json::ReadString(axis, "control_role");
    if (role != "primary" && role != "hint") {
      continue;
    }
    const auto definition_it = definitions.find(id);
    if (definition_it == definitions.end()) {
      continue;
    }
    const auto& definition = definition_it->second;
    const double raw_value = value_it->get<double>();
    if (!std::isfinite(raw_value)
        || raw_value < definition.value_min
        || raw_value > definition.value_max) {
      resolution.invalid_axis_value = true;
      continue;
    }
    const double value = expressive
        ? definition.neutral
            + (raw_value - definition.neutral) * intensity_scale
        : raw_value;
    resolution.values.emplace(
        id,
        AxisValue{value, definition.neutral, definition.group});
    explicit_axes.insert(id);
  }

  const auto relation_graph = profile.find("relation_graph");
  if (relation_graph == profile.end() || !relation_graph->is_object()) {
    return resolution;
  }
  const auto edges = relation_graph->find("edges");
  if (edges == relation_graph->end() || !edges->is_array()) {
    return resolution;
  }

  const auto clamp = [](double value, double minimum, double maximum) {
    return std::max(minimum, std::min(maximum, value));
  };
  const auto maps_equal = [](const AxisMap& left, const AxisMap& right) {
    if (left.size() != right.size()) {
      return false;
    }
    for (const auto& [axis_id, value] : left) {
      const auto other = right.find(axis_id);
      if (other == right.end()
          || std::abs(value.value - other->second.value) > 1e-6) {
        return false;
      }
    }
    return true;
  };

  AxisMap previous_values = resolution.values;
  const int max_passes = std::max(
      2,
      static_cast<int>(edges->size()) + 2);
  for (int pass = 0; pass < max_passes; ++pass) {
    AxisMap current_values = resolution.values;
    for (const auto& edge : *edges) {
      if (!edge.is_object()) {
        continue;
      }
      const auto source_id = json::ReadString(edge, "source_axis_id");
      const auto target_id = json::ReadString(edge, "target_axis_id");
      const auto source = previous_values.find(source_id);
      const auto target_definition = definitions.find(target_id);
      if (source == previous_values.end()
          || target_definition == definitions.end()) {
        continue;
      }
      const auto& target_axis = target_definition->second;
      const double source_delta =
          source->second.value - source->second.neutral;
      const double scale = json::ReadNumber(edge, "scale", 0.0);
      const double deadzone = std::max(
          0.0,
          json::ReadNumber(edge, "deadzone", 0.0));
      const double max_delta = std::max(
          0.0,
          json::ReadNumber(edge, "max_delta", 0.0));
      const double direction =
          json::ReadString(edge, "mode") == "opposite_direction" ? -1.0 : 1.0;
      const auto derive_target = [&]() {
        const double raw_candidate =
            target_axis.neutral + source_delta * scale * direction;
        const double max_delta_value = target_axis.neutral + clamp(
            raw_candidate - target_axis.neutral,
            -max_delta,
            max_delta);
        const double constrained_value = clamp(
            max_delta_value,
            target_axis.value_min,
            target_axis.value_max);
        return AxisValue{
            constrained_value,
            target_axis.neutral,
            target_axis.group};
      };
      if (json::ReadString(edge, "kind") == "derive") {
        if (explicit_axes.contains(target_id)
            || std::abs(source_delta) <= deadzone) {
          continue;
        }
        current_values[target_id] = derive_target();
        continue;
      }
      if (json::ReadString(edge, "kind") != "bounded_ratio") {
        continue;
      }
      const auto target = current_values.find(target_id);
      if (target == current_values.end()) {
        if (std::abs(source_delta) <= deadzone) {
          continue;
        }
        current_values[target_id] = derive_target();
        continue;
      }
      const double target_delta =
          target->second.value - target_axis.neutral;
      const double strong_half_span = std::max(
          std::abs(target_axis.strong_max - target_axis.neutral),
          std::abs(target_axis.neutral - target_axis.strong_min));
      const double hard_cap = std::max(
          max_delta,
          strong_half_span + std::min(deadzone, 6.0));
      const bool direction_mismatch =
          source_delta != 0.0
          && target_delta != 0.0
          && source_delta * target_delta * direction < 0.0;
      const double limit = direction_mismatch
          ? std::min(
              hard_cap * 0.5,
              std::max(
                  deadzone * 0.6,
                  std::abs(source_delta) * (scale * 0.35)
                      + deadzone * 0.5))
          : std::min(
              hard_cap,
              std::max(
                  deadzone,
                  std::abs(source_delta) * scale + deadzone));
      target->second.value = clamp(
          target_axis.neutral + clamp(target_delta, -limit, limit),
          target_axis.value_min,
          target_axis.value_max);
    }
    if (maps_equal(previous_values, current_values)) {
      resolution.values = std::move(current_values);
      return resolution;
    }
    previous_values = std::move(current_values);
  }
  resolution.values = std::move(previous_values);
  return resolution;
}

namespace {

double ClampValue(double value, double minimum, double maximum) {
  return std::max(minimum, std::min(maximum, value));
}

}  // namespace


std::optional<MotionPlan> CompileMotionPlan(
    const ag99::runtime::OutputSegment& segment,
    const NativeSegmentClock& clock,
    const MotionCompileContext& context) {
  if (segment.motion.state != ag99::runtime::MotionSlot::State::Present) {
    std::cerr << "[motion] output segment has no motion payload\n";
    return std::nullopt;
  }
  const auto& intent = segment.motion.payload;
  if (!intent.is_object()
      || json::ReadString(intent, "schema_version") !=
          std::string(ag99::runtime::kMotionIntentSchema)) {
    std::cerr << "[motion] unsupported motion intent schema\n";
    return std::nullopt;
  }
  const bool expressive = json::ReadString(intent, "mode") == "expressive";
  const auto* profile = context.profile;
  if (!profile) {
    std::cerr << "[motion] no semantic axis profile is available\n";
    return std::nullopt;
  }
  const auto profile_id = json::ReadString(*profile, "profile_id");
  if (!profile_id.empty()
      && json::ReadString(intent, "profile_id") != profile_id) {
    std::cerr << "[motion] profile id mismatch\n";
    return std::nullopt;
  }

  const auto axes = profile->find("axes");
  if (axes == profile->end() || !axes->is_array()) {
    return std::nullopt;
  }

  bool invalid_axis_value = false;
  std::vector<std::pair<ag99::runtime::Json, int>> input_steps;
  const auto steps = intent.find("motion_steps");
  if (steps == intent.end() || !steps->is_array() || steps->empty()
      || steps->size() > 4) {
    return std::nullopt;
  }
  for (const auto& step : *steps) {
    if (!step.is_object()) {
      return std::nullopt;
    }
    const auto values = step.find("axis_values");
    const auto weight = step.find("duration_weight");
    if (values == step.end() || !values->is_object()
        || weight == step.end() || !weight->is_number_integer()) {
      return std::nullopt;
    }
    const int duration_weight = weight->get<int>();
    if (duration_weight < 1 || duration_weight > 3) {
      return std::nullopt;
    }
    input_steps.emplace_back(*values, duration_weight);
  }
  if (input_steps.empty()) {
    return std::nullopt;
  }

  MotionPlan plan;
  plan.duration_ms = static_cast<int>(ClampValue(
      json::ReadNumber(intent, "duration_hint_ms", 900.0), 250.0, 5000.0));
  plan.blend_in_ms = std::min(140, std::max(40, plan.duration_ms / 5));
  plan.blend_out_ms = std::min(220, std::max(80, plan.duration_ms / 5));
  std::vector<AxisMap> resolved_steps;
  resolved_steps.reserve(input_steps.size());
  int total_weight = 0;
  for (const auto& [values, weight] : input_steps) {
    const auto resolution = ResolveAxisValues(
        *profile,
        values,
        expressive,
        context.intensity_scale);
    if (resolution.invalid_axis_value) {
      invalid_axis_value = true;
    }
    resolved_steps.push_back(resolution.values);
    total_weight += weight;
  }
  if (total_weight <= 0) {
    return std::nullopt;
  }
  if (invalid_axis_value) {
    return std::nullopt;
  }

  std::unordered_set<std::string> used_axis_ids;
  for (const auto& resolved : resolved_steps) {
    for (const auto& [axis_id, _] : resolved) {
      used_axis_ids.insert(axis_id);
    }
  }
  std::unordered_set<std::int32_t> bound_parameters;
  for (const auto& axis : *axes) {
    if (!axis.is_object()) {
      continue;
    }
    const auto axis_id = json::ReadString(axis, "id");
    if (!used_axis_ids.contains(axis_id)) {
      continue;
    }
    const auto bindings = axis.find("parameter_bindings");
    if (bindings == axis.end() || !bindings->is_array()) {
      continue;
    }
    for (const auto& binding : *bindings) {
      if (!binding.is_object()) {
        continue;
      }
      const auto parameter_id = json::ReadString(binding, "parameter_id");
      const auto parameter = context.resolve_parameter_index(parameter_id);
      if (parameter < 0 || bound_parameters.contains(parameter)) {
        continue;
      }
      const auto input_range = binding.find("input_range");
      const auto output_range = binding.find("output_range");
      if (input_range == binding.end() || output_range == binding.end()
          || !input_range->is_array() || !output_range->is_array()
          || input_range->size() != 2 || output_range->size() != 2) {
        continue;
      }
      const double input_min = (*input_range)[0].get<double>();
      const double input_max = (*input_range)[1].get<double>();
      const double output_min = (*output_range)[0].get<double>();
      const double output_max = (*output_range)[1].get<double>();
      if (std::abs(input_max - input_min) < 0.0001) {
        continue;
      }
      const bool invert = binding.value("invert", false);
      const double neutral_ratio = ClampValue(
          (json::ReadNumber(axis, "neutral", 50.0) - input_min)
              / (input_max - input_min),
          0.0, 1.0);
      const double neutral_effective_ratio = invert
          ? 1.0 - neutral_ratio : neutral_ratio;
      const float neutral_target = static_cast<float>(
          output_min + (output_max - output_min) * neutral_effective_ratio);
      std::vector<MotionTrack::Keyframe> keyframes;
      bool axis_started = false;
      AxisValue previous_value{};
      int accumulated_weight = 0;
      for (std::size_t step_index = 0;
           step_index < resolved_steps.size();
           ++step_index) {
        const auto value_it = resolved_steps[step_index].find(axis_id);
        if (value_it != resolved_steps[step_index].end()) {
          previous_value = value_it->second;
          axis_started = true;
        }
        if (!axis_started) {
          accumulated_weight += input_steps[step_index].second;
          continue;
        }
        const double ratio = ClampValue(
            (previous_value.value - input_min)
                / (input_max - input_min),
            0.0,
            1.0);
        const double effective_ratio = invert ? 1.0 - ratio : ratio;
        const float target = static_cast<float>(
            output_min + (output_max - output_min) * effective_ratio);
        const int at_ms = static_cast<int>(std::lround(
            static_cast<double>(plan.duration_ms)
            * static_cast<double>(accumulated_weight)
            / static_cast<double>(total_weight)));
        if (keyframes.empty() || keyframes.back().target_value != target) {
          keyframes.push_back(MotionTrack::Keyframe{at_ms, target});
        }
        accumulated_weight += input_steps[step_index].second;
      }
      if (keyframes.empty()) {
        continue;
      }
      plan.tracks.push_back(MotionTrack{
          parameter,
          neutral_target,
            keyframes.front().at_ms,
          std::move(keyframes)});
      bound_parameters.insert(parameter);
    }
  }
  if (plan.tracks.empty()) {
    return std::nullopt;
  }
  plan.started_at = clock.started_at_seconds;
  plan.clock = clock;
  return plan;
}




std::optional<ParameterPlan> ParseParameterPlan(
    const ag99::runtime::OutputSegment& segment,
    const NativeSegmentClock& clock,
    const ParameterPlanContext& context) {
  if (segment.motion.state != ag99::runtime::MotionSlot::State::Present) {
    std::cerr << "[motion] output segment has no parameter plan\n";
    return std::nullopt;
  }
  const auto& payload = segment.motion.payload;
  if (!payload.is_object()
      || json::ReadString(payload, "schema_version")
          != std::string(ag99::runtime::kParameterPlanSchema)
      || !json::HasOnlyKeys(payload, {
           "schema_version", "profile_id", "profile_revision", "model_id",
           "mode", "emotion_label", "resource", "timing", "parameters",
           "diagnostics", "summary"})) {
    return std::nullopt;
  }
  const auto* profile = context.profile;
  if (!profile) {
    std::cerr << "[motion] parameter plan profile is unavailable\n";
    return std::nullopt;
  }
  const auto profile_id = json::ReadString(*profile, "profile_id");
  const auto model_id = json::ReadString(*profile, "model_id");
  if ((!profile_id.empty() && json::ReadString(payload, "profile_id") != profile_id)
      || (!model_id.empty() && json::ReadString(payload, "model_id") != model_id)) {
    std::cerr << "[motion] parameter plan profile/model mismatch\n";
    return std::nullopt;
  }
  const auto revision = payload.find("profile_revision");
  if (revision == payload.end() || !revision->is_number_integer()
      || revision->get<std::int64_t>() <= 0) {
    return std::nullopt;
  }
  if (const auto profile_revision = profile->find("revision");
      profile_revision != profile->end() && profile_revision->is_number_integer()
      && revision->get<std::int64_t>() != profile_revision->get<std::int64_t>()) {
    std::cerr << "[motion] parameter plan profile revision mismatch\n";
    return std::nullopt;
  }
  const auto mode = json::ReadString(payload, "mode");
  if (mode != "idle" && mode != "expressive"
      || json::ReadString(payload, "emotion_label").empty()) {
    return std::nullopt;
  }
  const auto timing = payload.find("timing");
  if (timing == payload.end() || !timing->is_object()
      || !json::HasOnlyKeys(*timing, {
           "duration_ms", "blend_in_ms", "hold_ms", "blend_out_ms", "curve_preset"})) {
    return std::nullopt;
  }
  const auto duration = timing->find("duration_ms");
  const auto blend_in = timing->find("blend_in_ms");
  const auto hold = timing->find("hold_ms");
  const auto blend_out = timing->find("blend_out_ms");
  if (duration == timing->end() || blend_in == timing->end()
      || hold == timing->end() || blend_out == timing->end()
      || !json::IsIntegerInRange(*duration, 320, 15000)
      || !json::IsIntegerInRange(*blend_in, 0, 15000)
      || !json::IsIntegerInRange(*hold, 0, 15000)
      || !json::IsIntegerInRange(*blend_out, 0, 15000)) {
    return std::nullopt;
  }
  const int duration_ms = static_cast<int>(duration->get<std::int64_t>());
  const int blend_in_ms = static_cast<int>(blend_in->get<std::int64_t>());
  const int hold_ms = static_cast<int>(hold->get<std::int64_t>());
  const int blend_out_ms = static_cast<int>(blend_out->get<std::int64_t>());
  if (blend_in_ms + hold_ms + blend_out_ms != duration_ms) {
    return std::nullopt;
  }
  ParameterPlan plan{
      .started_at = clock.started_at_seconds,
      .duration_ms = duration_ms,
      .blend_in_ms = blend_in_ms,
      .hold_ms = hold_ms,
      .blend_out_ms = blend_out_ms,
      .curve_preset = json::ReadString(*timing, "curve_preset"),
      .clock = clock,
  };
  if (plan.curve_preset.empty()) {
    plan.curve_preset = "smooth_hold";
  }
  static constexpr std::array<std::string_view, 5> kCurves = {
      "smooth_hold", "snap_hold_soft_release", "slow_build_quick_release",
      "pulse_settle", "breathing_swell"};
  if (std::find(kCurves.begin(), kCurves.end(), plan.curve_preset)
      == kCurves.end()) {
    return std::nullopt;
  }

  std::unordered_set<std::string> resource_parameter_ids;
  if (const auto resource = payload.find("resource");
      resource != payload.end() && !resource->is_null()) {
    if (!resource->is_object()
        || !json::HasOnlyKeys(*resource, {
             "kind", "resource_id", "expression_id", "parameter_ids"})
        || json::ReadString(*resource, "kind") != "expression"
        || json::ReadString(*resource, "resource_id").empty()
        || json::ReadString(*resource, "expression_id").empty()
        || !resource->contains("parameter_ids")
        || !resource->at("parameter_ids").is_array()
        || resource->at("parameter_ids").empty()) {
      return std::nullopt;
    }
    for (const auto& parameter_id : resource->at("parameter_ids")) {
      if (!parameter_id.is_string()
          || parameter_id.get<std::string>().empty()) {
        return std::nullopt;
      }
      resource_parameter_ids.insert(parameter_id.get<std::string>());
    }
    plan.expression_id = json::ReadString(*resource, "expression_id");
  }

  const auto parameters = payload.find("parameters");
  if (parameters == payload.end() || !parameters->is_array()
      || parameters->empty()) {
    return std::nullopt;
  }
  std::unordered_set<std::string> parameter_ids;
  for (const auto& item : *parameters) {
    if (!item.is_object()
        || !json::HasOnlyKeys(item, {
             "axis_id", "parameter_id", "activation_at_ms", "target_value",
             "neutral_target_value", "weight", "input_value", "source",
             "keyframes", "modulation", "dynamics"})) {
      return std::nullopt;
    }
    const auto axis_id = json::ReadString(item, "axis_id");
    const auto parameter_id = json::ReadString(item, "parameter_id");
    const auto activation = item.find("activation_at_ms");
    const auto target = item.find("target_value");
    const auto neutral = item.find("neutral_target_value");
    const auto weight = item.find("weight");
    const auto source = json::ReadString(item, "source");
    static constexpr std::array<std::string_view, 6> kSources = {
        "semantic_axis", "relation_graph", "speech_pose",
        "expression", "continuity", "manual"};
    if (axis_id.empty() || parameter_id.empty()
        || !parameter_ids.insert(parameter_id).second
        || activation == item.end() || target == item.end()
        || neutral == item.end() || weight == item.end()
        || !json::IsIntegerInRange(*activation, 0, duration_ms)
        || !json::IsFiniteNumber(*target) || !json::IsFiniteNumber(*neutral)
        || !json::IsFiniteNumber(*weight) || weight->get<double>() < 0.0
        || weight->get<double>() > 1.0
        || std::find(kSources.begin(), kSources.end(), source) == kSources.end()) {
      return std::nullopt;
    }
    const auto dynamics = item.find("dynamics");
    if (dynamics == item.end() || !dynamics->is_object()
        || !json::HasOnlyKeys(*dynamics, {
             "max_velocity", "max_acceleration", "max_speech_offset", "response"})) {
      return std::nullopt;
    }
    const auto max_velocity = dynamics->find("max_velocity");
    const auto max_acceleration = dynamics->find("max_acceleration");
    const auto max_speech_offset = dynamics->find("max_speech_offset");
    const auto response = dynamics->find("response");
    if (max_velocity == dynamics->end() || max_acceleration == dynamics->end()
        || max_speech_offset == dynamics->end() || response == dynamics->end()
        || !json::IsFiniteNumber(*max_velocity) || max_velocity->get<double>() <= 0
        || !json::IsFiniteNumber(*max_acceleration) || max_acceleration->get<double>() <= 0
        || !json::IsFiniteNumber(*max_speech_offset) || max_speech_offset->get<double>() < 0
        || !response->is_object()) {
      return std::nullopt;
    }
    ParameterPlanBinding binding{
        .axis_id = axis_id,
        .parameter_id = parameter_id,
        .activation_at_ms = static_cast<int>(activation->get<std::int64_t>()),
        .target_value = static_cast<float>(target->get<double>()),
        .neutral_target_value = static_cast<float>(neutral->get<double>()),
        .weight = static_cast<float>(weight->get<double>()),
        .max_speech_offset = static_cast<float>(max_speech_offset->get<double>()),
        .presentation = ParameterPresentationState{
            .max_velocity = static_cast<float>(max_velocity->get<double>()),
            .max_acceleration = static_cast<float>(max_acceleration->get<double>()),
        },
    };
    const auto response_kind = json::ReadString(*response, "kind");
    if (response_kind == "bounded") {
      if (!json::HasOnlyKeys(*response, {"kind"})) {
        return std::nullopt;
      }
    } else if (response_kind == "spring") {
      if (!json::HasOnlyKeys(*response, {"kind", "frequency_hz", "damping_ratio"})
          || !response->contains("frequency_hz")
          || !response->contains("damping_ratio")
          || !json::IsFiniteNumber(response->at("frequency_hz"))
          || !json::IsFiniteNumber(response->at("damping_ratio"))
          || response->at("frequency_hz").get<double>() <= 0
          || response->at("frequency_hz").get<double>() > 10
          || response->at("damping_ratio").get<double>() < 0.5
          || response->at("damping_ratio").get<double>() >= 1) {
        return std::nullopt;
      }
      binding.presentation.response_frequency_hz =
          static_cast<float>(response->at("frequency_hz").get<double>());
      binding.presentation.response_damping_ratio =
          static_cast<float>(response->at("damping_ratio").get<double>());
    } else {
      return std::nullopt;
    }
    binding.presentation.response_kind = response_kind;

    if (const auto keyframes = item.find("keyframes");
        keyframes != item.end()) {
      if (!keyframes->is_array() || keyframes->size() < 2
          || keyframes->size() > 4) {
        return std::nullopt;
      }
      int previous_at = -1;
      int previous_end = -1;
      for (const auto& point : *keyframes) {
        const auto parsed = ParseTrackPoint(
            point, duration_ms, false);
        if (!parsed || parsed->at_ms <= previous_at
            || parsed->at_ms < previous_end) {
          return std::nullopt;
        }
        previous_at = parsed->at_ms;
        previous_end = parsed->at_ms + parsed->transition_ms;
        binding.keyframes.push_back(*parsed);
      }
      if (binding.keyframes.front().at_ms != binding.activation_at_ms
          || binding.keyframes.front().transition_ms != 0) {
        return std::nullopt;
      }
    }
    if (const auto modulation = item.find("modulation");
        modulation != item.end()) {
      if (!modulation->is_object()
          || !json::HasOnlyKeys(*modulation, {
               "kind", "preset", "amplitude", "direction", "delay_ms", "points"})
          || json::ReadString(*modulation, "kind") != "speech_gesture_track"
          || (json::ReadString(*modulation, "preset") != "calm_explain"
              && json::ReadString(*modulation, "preset") != "lively_chat"
              && json::ReadString(*modulation, "preset") != "gentle_support"
              && json::ReadString(*modulation, "preset") != "emphatic")
          || !modulation->contains("amplitude")
          || !modulation->contains("direction")
          || !modulation->contains("delay_ms")
          || !modulation->contains("points")
          || !json::IsFiniteNumber(modulation->at("amplitude"))
          || modulation->at("amplitude").get<double>() < 0
          || (modulation->at("direction") != 1
              && modulation->at("direction") != -1)
          || !json::IsIntegerInRange(modulation->at("delay_ms"), 0, 600)
          || !modulation->at("points").is_array()
          || modulation->at("points").size() < 3
          || modulation->at("points").size() > 8) {
        return std::nullopt;
      }
      binding.modulation_amplitude =
          std::min(
              binding.max_speech_offset,
              static_cast<float>(modulation->at("amplitude").get<double>()));
      binding.modulation_direction =
          modulation->at("direction").get<int>();
      binding.modulation_delay_ms =
          static_cast<int>(modulation->at("delay_ms").get<std::int64_t>());
      int previous_at = -1;
      int previous_end = -1;
      for (const auto& point : modulation->at("points")) {
        const auto parsed = ParseTrackPoint(point, duration_ms, true);
        if (!parsed || parsed->at_ms <= previous_at
            || parsed->at_ms < previous_end
            || parsed->at_ms + parsed->transition_ms
                 + binding.modulation_delay_ms > duration_ms) {
          return std::nullopt;
        }
        previous_at = parsed->at_ms;
        previous_end = parsed->at_ms + parsed->transition_ms;
        binding.modulation_points.push_back(*parsed);
      }
      if (binding.modulation_points.front().at_ms != 0
          || binding.modulation_points.front().transition_ms != 0
          || std::abs(binding.modulation_points.front().value) > 1e-6f) {
        return std::nullopt;
      }
    }
    const auto descriptor = context.resolve_parameter(parameter_id);
    if (!descriptor) {
      std::cerr << "[motion] parameter plan parameter is missing: "
                << parameter_id << '\n';
      return std::nullopt;
    }
    binding.parameter_index = descriptor->index;
    const auto minimum = descriptor->minimum;
    const auto maximum = descriptor->maximum;
    if (binding.target_value < minimum || binding.target_value > maximum
        || binding.neutral_target_value < minimum
        || binding.neutral_target_value > maximum) {
      return std::nullopt;
    }
    binding.presentation.initial_value = descriptor->current;
    binding.presentation.neutral_value = binding.neutral_target_value;
    for (const auto& point : binding.keyframes) {
      if (point.value < minimum || point.value > maximum) {
        return std::nullopt;
      }
    }
    if (resource_parameter_ids.contains(parameter_id)) {
      return std::nullopt;
    }
    plan.bindings.push_back(std::move(binding));
  }
  if (plan.bindings.empty()) {
    return std::nullopt;
  }
  return plan;
}



}  // namespace ag99::native::motion
