from __future__ import annotations

from copy import deepcopy
from typing import Any, Callable

from ...prompts.motion_selector import resolve_motion_reference_examples
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
                self._persist_cache()
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
            prompt_axes = profile_prompt_axes(profile)
            prompt_axis_ids = {
                str(axis.get("id") or "").strip()
                for axis in prompt_axes
                if str(axis.get("id") or "").strip()
            }
            prompt_axis_by_id = {
                str(axis.get("id") or "").strip(): axis
                for axis in prompt_axes
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
        projection_diagnostics: list[str] = []
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
            compiled_motion = sample.get("compiled_semantic_motion")
            filtered_axes = self._filter_example_axes(
                adjusted_axes,
                allowed_axis_ids=prompt_axis_ids,
            )
            if not filtered_axes:
                continue
            adjusted_levels = self._project_axes_to_levels(
                filtered_axes,
                axis_by_id=prompt_axis_by_id,
            )
            if not adjusted_levels:
                continue
            intent_tags = self._build_sample_intent_tags(sample)
            reference_error = self._validate_reference_effect_fields(
                intent_tags=intent_tags,
                compiled_motion=compiled_motion,
            )
            if reference_error:
                projection_diagnostics.append(
                    "motion_tuning_reference_sample_rejected:"
                    f"id={str(sample.get('id') or '').strip() or '<empty>'}:"
                    f"reason={reference_error}"
                )
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
                    "mode": str(compiled_motion.get("mode") or "expressive").strip()
                    or "expressive"
                    if isinstance(compiled_motion, dict)
                    else "expressive",
                    "axis_levels": adjusted_levels,
                }
            )
            duration_ms = None
            if isinstance(compiled_motion, dict):
                timing = compiled_motion.get("timing")
                if isinstance(timing, dict):
                    duration_ms = timing.get("resolvedDurationMs")
            normalized_examples.append(
                {
                    "category": str(sample.get("emotion_label") or "custom").strip()
                    or "custom",
                    "input": self._build_sample_input_text(sample),
                    "output": {
                        "intent_tags": intent_tags,
                        "axis_levels": adjusted_levels,
                        **(
                            {"duration_hint_ms": int(round(float(duration_ms)))}
                            if isinstance(duration_ms, (int, float))
                            and not isinstance(duration_ms, bool)
                            else {}
                        ),
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
        self.fewshot_diagnostics.extend(projection_diagnostics)

    @staticmethod
    def _build_sample_intent_tags(sample: dict[str, Any]) -> list[str]:
        tags = (
            [str(tag).strip() for tag in sample.get("tags", [])]
            if isinstance(sample.get("tags"), list)
            else []
        )
        emotion = str(sample.get("emotion_label") or "").strip()
        if emotion and emotion not in tags:
            tags.insert(0, emotion)
        return tags

    @staticmethod
    def _validate_reference_effect_fields(
        *,
        intent_tags: list[str],
        compiled_motion: Any,
    ) -> str:
        if not 1 <= len(intent_tags) <= 6:
            return "intent_tag_count_invalid"
        if any(not tag or len(tag) > 48 for tag in intent_tags):
            return "intent_tag_invalid"
        if len(set(intent_tags)) != len(intent_tags):
            return "intent_tags_not_unique"
        if not isinstance(compiled_motion, dict):
            return "compiled_semantic_motion_invalid"
        timing = compiled_motion.get("timing")
        duration_ms = timing.get("resolvedDurationMs") if isinstance(timing, dict) else None
        if (
            not isinstance(duration_ms, (int, float))
            or isinstance(duration_ms, bool)
            or not 320 <= float(duration_ms) <= 15000
        ):
            return "duration_hint_ms_out_of_range"
        return ""

    def _refresh_effective_examples(self) -> None:
        self.effective_examples = deepcopy(
            resolve_motion_reference_examples(
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
    def _build_style_prompt(samples: list[dict[str, Any]]) -> str:
        if not samples:
            return ""

        axis_frequency: dict[str, int] = {}
        idle_axis_counts: list[int] = []
        expressive_axis_counts: list[int] = []
        emotion_preferences: dict[str, list[str]] = {}

        for sample in samples:
            axes = sample.get("axis_levels")
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
                        -abs(float(axes.get(axis_id, 0.0))),
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

    @staticmethod
    def _project_axes_to_levels(
        axes: dict[str, float],
        *,
        axis_by_id: dict[str, dict[str, Any]],
    ) -> dict[str, int]:
        result: dict[str, int] = {}
        for axis_id, value in axes.items():
            axis = axis_by_id.get(axis_id)
            anchors = axis.get("level_anchors") if isinstance(axis, dict) else None
            if not isinstance(anchors, dict):
                continue
            candidates: list[tuple[float, int]] = []
            for level in range(-4, 5):
                anchor = anchors.get(str(level))
                if isinstance(anchor, (int, float)):
                    candidates.append((abs(float(value) - float(anchor)), level))
            if not candidates:
                continue
            result[axis_id] = min(candidates, key=lambda item: (item[0], abs(item[1])))[1]
        return result

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
        compiled_motion = self._normalize_compiled_semantic_motion(
            sample_payload.get("compiled_semantic_motion"),
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
            "compiled_semantic_motion": compiled_motion,
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

    def _normalize_compiled_semantic_motion(
        self,
        motion_payload: Any,
        *,
        model_name: str,
        profile_id: str,
        profile_revision: int,
    ) -> dict[str, Any]:
        if not isinstance(motion_payload, dict):
            raise ValueError("motion_tuning_sample_compiled_semantic_motion_not_object")
        if motion_payload.get("schemaVersion") != "engine.compiled_semantic_motion.v1":
            raise ValueError("motion_tuning_sample_compiled_semantic_motion_schema_invalid")
        if str(motion_payload.get("modelId") or "").strip() != model_name:
            raise ValueError("motion_tuning_sample_compiled_semantic_motion_model_mismatch")
        if str(motion_payload.get("profileId") or "").strip() != profile_id:
            raise ValueError("motion_tuning_sample_compiled_semantic_motion_profile_mismatch")
        motion_profile_revision = motion_payload.get("profileRevision")
        if (
            isinstance(motion_profile_revision, bool)
            or motion_profile_revision != profile_revision
        ):
            raise ValueError("motion_tuning_sample_compiled_semantic_motion_revision_mismatch")
        if motion_payload.get("kind") not in {"pose", "sequence"}:
            raise ValueError("motion_tuning_sample_compiled_semantic_motion_kind_invalid")
        if motion_payload.get("mode") not in {"idle", "expressive"}:
            raise ValueError("motion_tuning_sample_compiled_semantic_motion_mode_invalid")
        if not str(motion_payload.get("emotionLabel") or "").strip():
            raise ValueError("motion_tuning_sample_compiled_semantic_motion_emotion_invalid")
        intent_tags = motion_payload.get("intentTags")
        if (
            not isinstance(intent_tags, list)
            or not 1 <= len(intent_tags) <= 6
            or not all(isinstance(tag, str) and tag.strip() for tag in intent_tags)
            or len(set(intent_tags)) != len(intent_tags)
        ):
            raise ValueError("motion_tuning_sample_compiled_semantic_motion_tags_invalid")
        expression_resource_raw = motion_payload.get("expressionResourceId")
        motion_resource_raw = motion_payload.get("motionResourceId")
        if expression_resource_raw is not None and (
            not isinstance(expression_resource_raw, str)
            or not expression_resource_raw.strip()
        ):
            raise ValueError("motion_tuning_sample_compiled_semantic_motion_resource_invalid")
        if motion_resource_raw is not None and (
            not isinstance(motion_resource_raw, str)
            or not motion_resource_raw.strip()
        ):
            raise ValueError("motion_tuning_sample_compiled_semantic_motion_resource_invalid")
        expression_resource_id = str(expression_resource_raw or "").strip()
        motion_resource_id = str(motion_resource_raw or "").strip()
        if expression_resource_id and motion_resource_id:
            raise ValueError("motion_tuning_sample_compiled_semantic_motion_resource_conflict")
        self._validate_performance_curve_hint(
            motion_payload.get("performanceCurveHint")
        )
        self._validate_compiled_motion_timing(motion_payload.get("timing"))
        self._validate_compiled_motion_diagnostics(motion_payload.get("diagnostics"))
        if motion_payload["kind"] == "pose":
            self._validate_compiled_motion_axes(motion_payload.get("axes"))
        else:
            steps = motion_payload.get("steps")
            if not isinstance(steps, list) or not steps:
                raise ValueError("motion_tuning_sample_compiled_semantic_motion_steps_invalid")
            for step in steps:
                if not isinstance(step, dict):
                    raise ValueError("motion_tuning_sample_compiled_semantic_motion_step_invalid")
                duration_weight = _coerce_finite_number(step.get("durationWeight"))
                if duration_weight is None or duration_weight <= 0:
                    raise ValueError(
                        "motion_tuning_sample_compiled_semantic_motion_step_weight_invalid"
                    )
                self._validate_compiled_motion_axes(step.get("axes"))
                self._validate_compiled_motion_diagnostics(step.get("diagnostics"))
        return deepcopy(motion_payload)

    @staticmethod
    def _validate_performance_curve_hint(hint_payload: Any) -> None:
        if hint_payload is None:
            return
        if (
            not isinstance(hint_payload, dict)
            or hint_payload.get("schema_version") != "ag99.performance_curve_hint.v1"
            or hint_payload.get("curve_family")
            not in {
                "default",
                "quick_in_hold_soft_out",
                "slow_in_hold_quick_out",
                "pulse_then_settle",
                "soft_breathe",
            }
            or hint_payload.get("entry") not in {"instant", "quick", "soft", "slow"}
            or hint_payload.get("hold") not in {"short", "steady", "long", "breathing"}
            or hint_payload.get("exit") not in {"quick", "soft", "slow"}
            or hint_payload.get("emphasis")
            not in {"none", "early", "middle", "late", "punctuated"}
            or hint_payload.get("energy")
            not in {"low", "medium", "high", "teasing", "calm"}
        ):
            raise ValueError(
                "motion_tuning_sample_compiled_semantic_motion_performance_curve_invalid"
            )

    @staticmethod
    def _validate_compiled_motion_axes(axes_payload: Any) -> None:
        if not isinstance(axes_payload, list) or not axes_payload:
            raise ValueError("motion_tuning_sample_compiled_semantic_motion_axes_invalid")
        axis_ids: set[str] = set()
        for axis in axes_payload:
            if not isinstance(axis, dict):
                raise ValueError("motion_tuning_sample_compiled_semantic_motion_axis_invalid")
            axis_id = str(axis.get("axisId") or "").strip()
            value = _coerce_finite_number(axis.get("value"))
            neutral_value = _coerce_finite_number(axis.get("neutralValue"))
            if (
                not axis_id
                or axis_id in axis_ids
                or value is None
                or neutral_value is None
                or axis.get("source") not in {"semantic_axis", "coupling"}
            ):
                raise ValueError("motion_tuning_sample_compiled_semantic_motion_axis_invalid")
            axis_ids.add(axis_id)

    @staticmethod
    def _validate_compiled_motion_timing(timing_payload: Any) -> None:
        if not isinstance(timing_payload, dict):
            raise ValueError("motion_tuning_sample_compiled_semantic_motion_timing_invalid")
        resolved_duration = _coerce_finite_number(timing_payload.get("resolvedDurationMs"))
        if resolved_duration is None or resolved_duration <= 0:
            raise ValueError("motion_tuning_sample_compiled_semantic_motion_duration_invalid")
        if timing_payload.get("timingSource") not in {"hint", "audio_sync", "default"}:
            raise ValueError("motion_tuning_sample_compiled_semantic_motion_timing_source_invalid")
        timing = timing_payload.get("timing")
        if not isinstance(timing, dict):
            raise ValueError("motion_tuning_sample_compiled_semantic_motion_timing_invalid")
        for field_name in ("duration_ms", "blend_in_ms", "hold_ms", "blend_out_ms"):
            field_value = _coerce_finite_number(timing.get(field_name))
            if field_value is None or field_value < 0:
                raise ValueError(
                    f"motion_tuning_sample_compiled_semantic_motion_{field_name}_invalid"
                )

    @staticmethod
    def _validate_compiled_motion_diagnostics(diagnostics_payload: Any) -> None:
        if not isinstance(diagnostics_payload, dict):
            raise ValueError("motion_tuning_sample_compiled_semantic_motion_diagnostics_invalid")
        compiled_count = _coerce_finite_number(
            diagnostics_payload.get("compiledParameterCount")
        )
        intensity_scale = _coerce_finite_number(
            diagnostics_payload.get("motionIntensityScale")
        )
        if (
            not isinstance(diagnostics_payload.get("usedActionLibrary"), bool)
            or compiled_count is None
            or compiled_count < 0
            or int(compiled_count) != compiled_count
            or diagnostics_payload.get("timingSource")
            not in {"hint", "audio_sync", "default"}
            or diagnostics_payload.get("resolvedMode") not in {"idle", "expressive"}
            or not isinstance(diagnostics_payload.get("intensityApplied"), bool)
            or intensity_scale is None
        ):
            raise ValueError("motion_tuning_sample_compiled_semantic_motion_diagnostics_invalid")

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
                or raw_level < -4
                or raw_level > 4
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
        return [str(tag or "").strip() for tag in tags_payload]

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
