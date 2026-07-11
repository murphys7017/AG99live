from __future__ import annotations

from copy import deepcopy
from typing import Any, Callable

from ...motion.motion_intent import PARAMETER_PLAN_SOURCES
from ...prompts.motion_selector import resolve_selector_few_shot_examples
from ...prompts.semantic_axis_prompt import profile_prompt_axes


class MotionTuningStore:
    """Owns persisted motion-tuning samples and their prompt projections."""

    def __init__(
        self,
        *,
        runtime_state: Any,
        get_selected_profile: Callable[[], dict[str, Any] | None],
        ensure_cache_writable: Callable[[], None],
        persist_cache: Callable[[], None],
    ) -> None:
        self._runtime_state = runtime_state
        self._get_selected_profile = get_selected_profile
        self._ensure_cache_writable = ensure_cache_writable
        self._persist_cache = persist_cache

        self.samples: list[dict[str, Any]] = []
        self.samples_load_error = ""
        self.reference_examples: list[dict[str, Any]] = []
        self.fewshot_diagnostics: list[str] = []
        self.effective_examples: list[dict[str, Any]] = []
        self.style_prompt = ""

    def load_from_payload(self, payload: dict[str, Any]) -> None:
        raw_samples = payload.get("motion_tuning_samples")
        if not isinstance(raw_samples, list):
            self.samples = []
            return

        normalized_samples: list[dict[str, Any]] = []
        for sample in raw_samples:
            try:
                normalized_samples.append(self.normalize_sample(sample))
            except ValueError as exc:
                self.samples_load_error = (
                    "motion_tuning_samples_invalid_persisted_sample"
                    f": {exc}"
                )
                self.samples = []
                self.reference_examples = []
                return
        self.samples = normalized_samples

    def list_samples(self) -> list[dict[str, Any]]:
        return deepcopy(self.samples)

    def list_fewshot_diagnostics(self) -> list[str]:
        return list(self.fewshot_diagnostics)

    def list_effective_examples(self) -> list[dict[str, Any]]:
        return deepcopy(self.effective_examples)

    def build_style_prompt(self) -> str:
        return str(self.style_prompt or "")

    def save_sample(self, sample_payload: Any) -> dict[str, Any]:
        self._ensure_cache_writable()
        normalized_sample = self.normalize_sample(sample_payload)
        self.samples_load_error = ""
        self.samples = [
            deepcopy(normalized_sample),
            *[
                deepcopy(item)
                for item in self.samples
                if str(item.get("id") or "").strip() != normalized_sample["id"]
            ],
        ]
        self._persist_cache()
        self.refresh_reference_examples()
        return deepcopy(normalized_sample)

    def delete_sample(self, sample_id: Any) -> bool:
        self._ensure_cache_writable()
        normalized_sample_id = str(sample_id or "").strip()
        if not normalized_sample_id:
            raise ValueError("`sample_id` is required.")
        remaining_samples = [
            deepcopy(item)
            for item in self.samples
            if str(item.get("id") or "").strip() != normalized_sample_id
        ]
        if len(remaining_samples) == len(self.samples):
            raise ValueError(f"motion_tuning_sample_not_found: {normalized_sample_id}")
        self.samples_load_error = ""
        self.samples = remaining_samples
        self._persist_cache()
        self.refresh_reference_examples()
        return True

    def refresh_reference_examples(self) -> None:
        self.fewshot_diagnostics = []
        self.effective_examples = []
        self.style_prompt = ""
        profile = self._get_selected_profile()
        if not isinstance(profile, dict):
            self.reference_examples = []
            self._refresh_effective_examples()
            return

        profile_id = str(profile.get("profile_id") or "").strip()
        profile_revision = profile.get("revision")
        if not profile_id or not isinstance(profile_revision, int) or profile_revision <= 0:
            self.reference_examples = []
            self._refresh_effective_examples()
            return
        try:
            prompt_axis_ids = {
                str(axis.get("id") or "").strip()
                for axis in profile_prompt_axes(profile)
                if str(axis.get("id") or "").strip()
            }
        except Exception:
            self.reference_examples = []
            self._refresh_effective_examples()
            return
        if not prompt_axis_ids:
            self.reference_examples = []
            self._refresh_effective_examples()
            return

        normalized_examples: list[dict[str, Any]] = []
        style_samples: list[dict[str, Any]] = []
        for sample in self.samples:
            if not isinstance(sample, dict):
                continue
            if not bool(sample.get("enabled_for_llm_reference")):
                continue
            if str(sample.get("profile_id") or "").strip() != profile_id:
                continue
            if int(sample.get("profile_revision") or 0) != profile_revision:
                continue
            adjusted_axes = sample.get("adjusted_axes")
            if not isinstance(adjusted_axes, dict) or not adjusted_axes:
                continue
            adjusted_plan = sample.get("adjusted_plan")
            filtered_axes = self._filter_example_axes(
                adjusted_axes,
                allowed_axis_ids=prompt_axis_ids,
            )
            if not filtered_axes:
                continue
            if not self._example_matches_adjusted_plan(filtered_axes, adjusted_plan):
                continue
            style_samples.append(
                {
                    "emotion_label": str(sample.get("emotion_label") or "").strip(),
                    "feedback": str(sample.get("feedback") or "").strip(),
                    "tags": [
                        str(tag).strip()
                        for tag in sample.get("tags", [])
                        if str(tag).strip()
                    ]
                    if isinstance(sample.get("tags"), list)
                    else [],
                    "mode": str(adjusted_plan.get("mode") or "expressive").strip()
                    or "expressive"
                    if isinstance(adjusted_plan, dict)
                    else "expressive",
                    "axes": dict(filtered_axes),
                }
            )
            duration_ms = None
            mode = "expressive"
            if isinstance(adjusted_plan, dict):
                mode = str(adjusted_plan.get("mode") or "expressive").strip() or "expressive"
                timing = adjusted_plan.get("timing")
                if isinstance(timing, dict):
                    duration_ms = timing.get("duration_ms")
            normalized_examples.append(
                {
                    "input": self._build_sample_input_text(sample),
                    "output": {
                        "emotion": str(sample.get("emotion_label") or "custom").strip()
                        or "custom",
                        "mode": mode,
                        "duration_ms": duration_ms,
                        "axes": filtered_axes,
                    },
                    "source": "desktop_motion_tuning_sample_store",
                    "feedback": str(sample.get("feedback") or "").strip(),
                    "tags": [
                        str(tag).strip()
                        for tag in sample.get("tags", [])
                        if str(tag).strip()
                    ]
                    if isinstance(sample.get("tags"), list)
                    else [],
                }
            )
        self.reference_examples = normalized_examples
        self.style_prompt = self._build_style_prompt(style_samples)
        self._refresh_effective_examples()

    def _refresh_effective_examples(self) -> None:
        self.effective_examples = deepcopy(
            resolve_selector_few_shot_examples(
                runtime_state=self._runtime_state,
                update_runtime_state=True,
            )
        )

    @staticmethod
    def _filter_example_axes(
        adjusted_axes: dict[str, Any],
        *,
        allowed_axis_ids: set[str],
    ) -> dict[str, float]:
        result: dict[str, float] = {}
        for axis_id, raw_value in adjusted_axes.items():
            normalized_axis_id = str(axis_id or "").strip()
            if not normalized_axis_id or normalized_axis_id not in allowed_axis_ids:
                continue
            normalized_value = _coerce_finite_number(raw_value)
            if normalized_value is None:
                continue
            result[normalized_axis_id] = normalized_value
        return result

    @staticmethod
    def _example_matches_adjusted_plan(
        filtered_axes: dict[str, float],
        adjusted_plan: Any,
    ) -> bool:
        if not isinstance(adjusted_plan, dict):
            return False
        raw_parameters = adjusted_plan.get("parameters")
        if not isinstance(raw_parameters, list) or not raw_parameters:
            return False
        plan_axis_ids = {
            str(parameter.get("axis_id") or "").strip()
            for parameter in raw_parameters
            if isinstance(parameter, dict) and str(parameter.get("axis_id") or "").strip()
        }
        if not plan_axis_ids:
            return False
        return set(filtered_axes.keys()).issubset(plan_axis_ids)

    @staticmethod
    def _build_style_prompt(samples: list[dict[str, Any]]) -> str:
        if not samples:
            return ""

        axis_frequency: dict[str, int] = {}
        idle_axis_counts: list[int] = []
        expressive_axis_counts: list[int] = []
        emotion_preferences: dict[str, list[str]] = {}

        for sample in samples:
            axes = sample.get("axes")
            if not isinstance(axes, dict) or not axes:
                continue
            mode = str(sample.get("mode") or "expressive").strip().lower()
            axis_ids = [
                str(axis_id).strip()
                for axis_id in axes.keys()
                if str(axis_id).strip()
            ]
            if not axis_ids:
                continue
            for axis_id in axis_ids:
                axis_frequency[axis_id] = axis_frequency.get(axis_id, 0) + 1
            if mode == "idle":
                idle_axis_counts.append(len(axis_ids))
            else:
                expressive_axis_counts.append(len(axis_ids))

            emotion_label = str(sample.get("emotion_label") or "").strip().lower()
            if emotion_label:
                preferred_axes = sorted(
                    axis_ids,
                    key=lambda axis_id: (
                        -abs(float(axes.get(axis_id, 0.0)) - 50.0),
                        axis_id,
                    ),
                )[:3]
                if preferred_axes:
                    emotion_preferences.setdefault(emotion_label, [])
                    for axis_id in preferred_axes:
                        if axis_id not in emotion_preferences[emotion_label]:
                            emotion_preferences[emotion_label].append(axis_id)

        if not axis_frequency:
            return ""

        top_axes = [
            axis_id
            for axis_id, _ in sorted(
                axis_frequency.items(),
                key=lambda item: (-item[1], item[0]),
            )[:5]
        ]

        lines = ["优先保持当前角色已经调出来的表演习惯，不要把少量示例当成固定模板。"]
        if top_axes:
            lines.append(
                "这个角色更常用这些轴来组织动作："
                + ", ".join(top_axes)
                + "。"
            )
        if idle_axis_counts:
            average_idle_axes = sum(idle_axis_counts) / len(idle_axis_counts)
            if average_idle_axes <= 2.4:
                lines.append("中性或说明性回复时，尽量少轴、收敛，优先用头部或视线轻微表达。")
            else:
                lines.append("中性或说明性回复时，可以保留少量细节轴，但不要把动作堆满。")
        if expressive_axis_counts:
            average_expressive_axes = sum(expressive_axis_counts) / len(
                expressive_axis_counts
            )
            if average_expressive_axes <= 3.2:
                lines.append("明确情绪时，也优先使用少量关键轴建立骨架，不要把每个细节轴都拉开。")
            else:
                lines.append("明确情绪时可以增加细节轴，但要让头身眼仍然是主骨架。")

        summarized_emotions = 0
        for emotion_label, preferred_axes in sorted(emotion_preferences.items()):
            if summarized_emotions >= 3 or not preferred_axes:
                break
            lines.append(
                f"{emotion_label} 这类语气下，可优先考虑 {', '.join(preferred_axes[:3])}。"
            )
            summarized_emotions += 1

        feedback_lines: list[str] = []
        seen_feedback: set[str] = set()
        for sample in samples:
            feedback = str(sample.get("feedback") or "").strip()
            if not feedback or feedback in seen_feedback:
                continue
            seen_feedback.add(feedback)
            feedback_lines.append(feedback)
            if len(feedback_lines) >= 2:
                break
        if feedback_lines:
            lines.append("已记录的调参偏好：" + "；".join(feedback_lines) + "。")

        lines.append("每次仍应先理解这轮对话语气，再在上述风格范围内自由生成。")
        return "\n".join(lines)

    def normalize_sample(self, sample_payload: Any) -> dict[str, Any]:
        if not isinstance(sample_payload, dict):
            raise ValueError("motion_tuning_sample_not_object")

        sample_id = str(sample_payload.get("id") or "").strip()
        if not sample_id:
            raise ValueError("motion_tuning_sample_id_required")

        created_at = str(sample_payload.get("created_at") or "").strip()
        if not created_at:
            raise ValueError("motion_tuning_sample_created_at_required")

        source_record_id = str(sample_payload.get("source_record_id") or "").strip()
        if not source_record_id:
            raise ValueError("motion_tuning_sample_source_record_id_required")

        model_name = str(sample_payload.get("model_name") or "").strip()
        if not model_name:
            raise ValueError("motion_tuning_sample_model_name_required")

        profile_id = str(sample_payload.get("profile_id") or "").strip()
        if not profile_id:
            raise ValueError("motion_tuning_sample_profile_id_required")

        profile_revision_raw = sample_payload.get("profile_revision")
        if isinstance(profile_revision_raw, bool):
            raise ValueError("motion_tuning_sample_profile_revision_invalid")
        try:
            profile_revision = int(profile_revision_raw)
        except (TypeError, ValueError):
            raise ValueError("motion_tuning_sample_profile_revision_invalid") from None
        if profile_revision <= 0:
            raise ValueError("motion_tuning_sample_profile_revision_invalid")

        adjusted_axes = self._normalize_axes(
            sample_payload.get("adjusted_axes"),
            field_name="adjusted_axes",
            require_non_empty=True,
        )
        original_axes = self._normalize_axes(
            sample_payload.get("original_axes"),
            field_name="original_axes",
            require_non_empty=False,
        )
        raw_axis_levels = self._normalize_axis_levels(
            sample_payload.get("raw_axis_levels")
        )
        resolved_axes = self._normalize_axes(
            sample_payload.get("resolved_axes", {}),
            field_name="resolved_axes",
            require_non_empty=False,
        )
        constrained_axes = self._normalize_axes(
            sample_payload.get("constrained_axes", {}),
            field_name="constrained_axes",
            require_non_empty=False,
        )
        adjusted_plan = self._normalize_adjusted_plan(
            sample_payload.get("adjusted_plan"),
            model_name=model_name,
            profile_id=profile_id,
            profile_revision=profile_revision,
        )

        normalized_sample = {
            "id": sample_id,
            "created_at": created_at,
            "source_record_id": source_record_id,
            "model_name": model_name,
            "profile_id": profile_id,
            "profile_revision": profile_revision,
            "emotion_label": str(
                sample_payload.get("emotion_label") or ""
            ).strip()
            or "manual_tuning",
            "assistant_text": str(sample_payload.get("assistant_text") or "").strip(),
            "feedback": str(sample_payload.get("feedback") or "").strip(),
            "tags": self._normalize_tags(sample_payload.get("tags")),
            "enabled_for_llm_reference": bool(
                sample_payload.get("enabled_for_llm_reference")
            ),
            "original_axes": original_axes,
            "adjusted_axes": adjusted_axes,
            "adjusted_plan": adjusted_plan,
        }
        optional_values = {
            "profile_hash": str(sample_payload.get("profile_hash") or "").strip(),
            "transform_version": str(
                sample_payload.get("transform_version") or ""
            ).strip(),
            "raw_axis_levels": raw_axis_levels,
            "resolved_axes": resolved_axes,
            "constrained_axes": constrained_axes,
        }
        normalized_sample.update(
            {
                key: value
                for key, value in optional_values.items()
                if value not in ("", {})
            }
        )
        return normalized_sample

    def _normalize_adjusted_plan(
        self,
        plan_payload: Any,
        *,
        model_name: str,
        profile_id: str,
        profile_revision: int,
    ) -> dict[str, Any]:
        if not isinstance(plan_payload, dict):
            raise ValueError("motion_tuning_sample_adjusted_plan_not_object")
        if str(plan_payload.get("schema_version") or "").strip() != "engine.parameter_plan.v2":
            raise ValueError("motion_tuning_sample_adjusted_plan_schema_invalid")
        if str(plan_payload.get("model_id") or "").strip() != model_name:
            raise ValueError("motion_tuning_sample_adjusted_plan_model_mismatch")
        if str(plan_payload.get("profile_id") or "").strip() != profile_id:
            raise ValueError("motion_tuning_sample_adjusted_plan_profile_mismatch")

        plan_profile_revision_raw = plan_payload.get("profile_revision")
        if isinstance(plan_profile_revision_raw, bool):
            raise ValueError("motion_tuning_sample_adjusted_plan_revision_invalid")
        try:
            plan_profile_revision = int(plan_profile_revision_raw)
        except (TypeError, ValueError):
            raise ValueError("motion_tuning_sample_adjusted_plan_revision_invalid") from None
        if plan_profile_revision != profile_revision:
            raise ValueError("motion_tuning_sample_adjusted_plan_revision_mismatch")

        mode = str(plan_payload.get("mode") or "").strip()
        if mode not in {"idle", "expressive"}:
            raise ValueError("motion_tuning_sample_adjusted_plan_mode_invalid")

        timing_payload = plan_payload.get("timing")
        if not isinstance(timing_payload, dict):
            raise ValueError("motion_tuning_sample_adjusted_plan_timing_invalid")

        timing: dict[str, int] = {}
        for key in ("duration_ms", "blend_in_ms", "hold_ms", "blend_out_ms"):
            raw_value = timing_payload.get(key)
            if isinstance(raw_value, bool):
                raise ValueError(f"motion_tuning_sample_adjusted_plan_{key}_invalid")
            try:
                normalized_value = int(raw_value)
            except (TypeError, ValueError):
                raise ValueError(
                    f"motion_tuning_sample_adjusted_plan_{key}_invalid"
                ) from None
            if normalized_value < 0:
                raise ValueError(f"motion_tuning_sample_adjusted_plan_{key}_invalid")
            timing[key] = normalized_value

        raw_parameters = plan_payload.get("parameters")
        if not isinstance(raw_parameters, list) or not raw_parameters:
            raise ValueError("motion_tuning_sample_adjusted_plan_parameters_invalid")

        parameters: list[dict[str, Any]] = []
        for parameter in raw_parameters:
            if not isinstance(parameter, dict):
                raise ValueError("motion_tuning_sample_adjusted_plan_parameter_not_object")
            axis_id = str(parameter.get("axis_id") or "").strip()
            parameter_id = str(parameter.get("parameter_id") or "").strip()
            target_value = _coerce_finite_number(parameter.get("target_value"))
            weight = _coerce_finite_number(parameter.get("weight"))
            if (
                not axis_id
                or not parameter_id
                or target_value is None
                or weight is None
                or weight < 0
                or weight > 1
            ):
                raise ValueError("motion_tuning_sample_adjusted_plan_parameter_invalid")
            input_value_raw = parameter.get("input_value")
            input_value = _coerce_finite_number(input_value_raw)
            if input_value_raw is not None and input_value is None:
                raise ValueError("motion_tuning_sample_adjusted_plan_input_value_invalid")
            source = str(parameter.get("source") or "").strip()
            normalized_parameter = {
                "axis_id": axis_id,
                "parameter_id": parameter_id,
                "target_value": target_value,
                "weight": weight,
            }
            if input_value is not None:
                normalized_parameter["input_value"] = input_value
            if source in PARAMETER_PLAN_SOURCES:
                normalized_parameter["source"] = source
            parameters.append(normalized_parameter)

        normalized_plan: dict[str, Any] = {
            "schema_version": "engine.parameter_plan.v2",
            "profile_id": profile_id,
            "profile_revision": profile_revision,
            "model_id": model_name,
            "mode": mode,
            "emotion_label": str(
                plan_payload.get("emotion_label") or ""
            ).strip()
            or "manual_tuning",
            "timing": timing,
            "parameters": parameters,
        }
        diagnostics = plan_payload.get("diagnostics")
        if isinstance(diagnostics, dict):
            warnings = diagnostics.get("warnings")
            normalized_diagnostics: dict[str, Any] = {}
            if isinstance(warnings, list):
                normalized_diagnostics["warnings"] = [
                    str(item).strip() for item in warnings if str(item).strip()
                ]
            if normalized_diagnostics:
                normalized_plan["diagnostics"] = normalized_diagnostics
        summary = plan_payload.get("summary")
        if isinstance(summary, dict):
            normalized_summary: dict[str, Any] = {}
            for key in ("axis_count", "parameter_count", "target_duration_ms"):
                raw_value = summary.get(key)
                if isinstance(raw_value, bool):
                    continue
                try:
                    normalized_value = int(raw_value)
                except (TypeError, ValueError):
                    continue
                normalized_summary[key] = normalized_value
            if normalized_summary:
                normalized_plan["summary"] = normalized_summary
        return normalized_plan

    @staticmethod
    def _normalize_axes(
        axes_payload: Any,
        *,
        field_name: str,
        require_non_empty: bool,
    ) -> dict[str, float]:
        if not isinstance(axes_payload, dict):
            raise ValueError(f"motion_tuning_sample_{field_name}_not_object")
        result: dict[str, float] = {}
        for axis_id, raw_value in axes_payload.items():
            normalized_axis_id = str(axis_id or "").strip()
            normalized_value = _coerce_finite_number(raw_value)
            if not normalized_axis_id or normalized_value is None:
                continue
            result[normalized_axis_id] = normalized_value
        if require_non_empty and not result:
            raise ValueError(f"motion_tuning_sample_{field_name}_empty")
        return result

    @staticmethod
    def _normalize_axis_levels(value: Any) -> dict[str, int]:
        if value is None:
            return {}
        if not isinstance(value, dict):
            raise ValueError("motion_tuning_sample_raw_axis_levels_not_object")
        result: dict[str, int] = {}
        for raw_axis_id, raw_level in value.items():
            axis_id = str(raw_axis_id or "").strip()
            if not axis_id:
                raise ValueError("motion_tuning_sample_raw_axis_level_id_empty")
            if (
                isinstance(raw_level, bool)
                or not isinstance(raw_level, int)
                or raw_level < -3
                or raw_level > 3
            ):
                raise ValueError(
                    f"motion_tuning_sample_raw_axis_level_invalid:{axis_id}"
                )
            result[axis_id] = raw_level
        return result

    @staticmethod
    def _normalize_tags(tags_payload: Any) -> list[str]:
        if not isinstance(tags_payload, list):
            return []
        result: list[str] = []
        seen: set[str] = set()
        for tag in tags_payload:
            normalized_tag = str(tag or "").strip()
            if not normalized_tag or normalized_tag in seen:
                continue
            seen.add(normalized_tag)
            result.append(normalized_tag)
        return result

    @staticmethod
    def _build_sample_input_text(sample: dict[str, Any]) -> str:
        lines: list[str] = []
        assistant_text = str(sample.get("assistant_text") or "").strip()
        feedback = str(sample.get("feedback") or "").strip()
        tags = sample.get("tags")
        if assistant_text:
            lines.append(f"Assistant: {assistant_text}")
        if feedback:
            lines.append(f"Tuning note: {feedback}")
        if isinstance(tags, list):
            normalized_tags = [
                str(tag).strip() for tag in tags if str(tag).strip()
            ]
            if normalized_tags:
                lines.append(f"Tags: {', '.join(normalized_tags)}")
        return "\n".join(lines)


def _coerce_finite_number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if not isinstance(value, (int, float)):
        return None
    normalized = float(value)
    if normalized != normalized or normalized in {float("inf"), float("-inf")}:
        return None
    return normalized
