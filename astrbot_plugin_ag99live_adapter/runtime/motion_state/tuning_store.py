from __future__ import annotations

import json
from copy import deepcopy
from pathlib import Path
from typing import Any, Callable

from ...prompts.semantic_axis_prompt import profile_prompt_axes
from ...protocol.schema_versions import (
    MOTION_TUNING_SAMPLE_SCHEMA_VERSION,
    PERFORMANCE_CURVE_HINT_SCHEMA_VERSION,
)

MOTION_TUNING_STORE_SCHEMA_VERSION = "ag99.motion_tuning_store.v1"
REFERENCE_USER_TEXT_MAX_CHARS = 240
REFERENCE_ASSISTANT_TEXT_MAX_CHARS = 360


class MotionTuningStore:
    """Owns persisted motion-tuning samples and their prompt projections."""

    def __init__(
        self,
        *,
        storage_path: Path | None,
        get_selected_profile: Callable[[], dict[str, Any] | None],
        get_turn_context: Callable[[str, str], dict[str, str] | None],
    ) -> None:
        self._storage_path = Path(storage_path) if storage_path is not None else None
        self._get_selected_profile = get_selected_profile
        self._get_turn_context = get_turn_context

        self.samples: list[dict[str, Any]] = []
        self.samples_load_error = ""
        self.reference_examples: list[dict[str, Any]] = []
        self.fewshot_diagnostics: list[str] = []

    def load(self) -> None:
        self.samples = []
        self.samples_load_error = ""
        if self._storage_path is None or not self._storage_path.exists():
            return

        try:
            payload = json.loads(self._storage_path.read_text(encoding="utf-8-sig"))
        except Exception as exc:
            self.samples_load_error = f"motion_tuning_store_load_failed:{exc}"
            return
        if not isinstance(payload, dict):
            self.samples_load_error = "motion_tuning_store_payload_not_object"
            return
        if payload.get("schema_version") != MOTION_TUNING_STORE_SCHEMA_VERSION:
            self.samples_load_error = "motion_tuning_store_schema_version_mismatch"
            return

        raw_samples = payload.get("samples")
        if not isinstance(raw_samples, list):
            self.samples_load_error = "motion_tuning_store_samples_not_array"
            self.samples = []
            return

        normalized_samples: list[dict[str, Any]] = []
        for index, sample in enumerate(raw_samples):
            try:
                normalized_samples.append(self.normalize_sample(sample))
            except ValueError as exc:
                sample_id = (
                    str(sample.get("id") or "").strip()
                    if isinstance(sample, dict)
                    else ""
                )
                self.samples_load_error = (
                    "motion_tuning_store_sample_invalid:"
                    f"index={index}:id={sample_id or '<empty>'}:reason={exc}"
                )
                return
        self.samples = normalized_samples

    def list_samples(self) -> list[dict[str, Any]]:
        return deepcopy(self.samples)

    def list_fewshot_diagnostics(self) -> list[str]:
        return list(self.fewshot_diagnostics)

    def list_reference_examples(self) -> list[dict[str, Any]]:
        return deepcopy(self.reference_examples)

    def save_sample(self, sample_payload: Any) -> dict[str, Any]:
        self._ensure_writable()
        incoming_sample = self.normalize_sample(
            sample_payload,
            require_recorded_context=False,
        )
        existing_sample = next(
            (
                item
                for item in self.samples
                if str(item.get("id") or "").strip() == incoming_sample["id"]
            ),
            None,
        )
        if existing_sample is not None:
            for field_name in (
                "created_at",
                "source_record_id",
                "turn_id",
                "message_id",
                "model_name",
                "profile_id",
                "profile_revision",
                "profile_hash",
                "transform_version",
                "user_text",
                "assistant_text",
            ):
                if field_name in existing_sample:
                    incoming_sample[field_name] = deepcopy(existing_sample[field_name])
        else:
            recorded_context = self._get_turn_context(
                incoming_sample["turn_id"],
                incoming_sample["message_id"],
            )
            if not isinstance(recorded_context, dict):
                raise ValueError(
                    "motion_tuning_sample_context_not_recorded:"
                    f"{incoming_sample['turn_id']}:{incoming_sample['message_id']}"
                )
            incoming_sample["user_text"] = str(
                recorded_context.get("user_text") or ""
            ).strip()
            incoming_sample["assistant_text"] = str(
                recorded_context.get("assistant_text") or ""
            ).strip()
        normalized_sample = self.normalize_sample(incoming_sample)
        next_samples = [
            deepcopy(normalized_sample),
            *[
                deepcopy(item)
                for item in self.samples
                if str(item.get("id") or "").strip() != normalized_sample["id"]
            ],
        ]
        self._persist_samples(next_samples)
        self.samples = next_samples
        self.refresh_reference_examples()
        return deepcopy(normalized_sample)

    def delete_sample(self, sample_id: Any) -> bool:
        self._ensure_writable()
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
        self._persist_samples(remaining_samples)
        self.samples = remaining_samples
        self.refresh_reference_examples()
        return True

    def refresh_reference_examples(self) -> None:
        self.fewshot_diagnostics = []
        profile = self._get_selected_profile()
        if not isinstance(profile, dict):
            self.reference_examples = []
            return

        profile_id = str(profile.get("profile_id") or "").strip()
        profile_revision = profile.get("revision")
        if not profile_id or not isinstance(profile_revision, int) or profile_revision <= 0:
            self.reference_examples = []
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
        except Exception as exc:
            self.reference_examples = []
            self.fewshot_diagnostics = [
                f"motion_tuning_reference_profile_invalid:{exc}"
            ]
            return
        if not prompt_axis_ids:
            self.reference_examples = []
            return

        normalized_examples: list[dict[str, Any]] = []
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
            projected_output, reference_error = (
                self._project_sample_reference_output(
                    sample,
                    allowed_axis_ids=prompt_axis_ids,
                    axis_by_id=prompt_axis_by_id,
                )
            )
            if reference_error:
                projection_diagnostics.append(
                    "motion_tuning_reference_sample_rejected:"
                    f"id={str(sample.get('id') or '').strip() or '<empty>'}:"
                    f"reason={reference_error}"
                )
                continue
            if not projected_output:
                continue
            user_text = self._truncate_reference_text(
                sample.get("user_text"),
                REFERENCE_USER_TEXT_MAX_CHARS,
            )
            assistant_text = self._truncate_reference_text(
                sample.get("assistant_text"),
                REFERENCE_ASSISTANT_TEXT_MAX_CHARS,
            )
            normalized_examples.append(
                {
                    "sample_id": str(sample.get("id") or "").strip(),
                    "created_at": str(sample.get("created_at") or "").strip(),
                    "category": str(sample.get("emotion_label") or "custom").strip()
                    or "custom",
                    "user_text": user_text,
                    "assistant_text": assistant_text,
                    "input": self._build_sample_input_text(
                        {
                            "user_text": user_text,
                            "assistant_text": assistant_text,
                        }
                    ),
                    "output": projected_output,
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

    def _project_sample_reference_output(
        self,
        sample: dict[str, Any],
        *,
        allowed_axis_ids: set[str],
        axis_by_id: dict[str, dict[str, Any]],
    ) -> tuple[dict[str, Any] | None, str]:
        compiled_motion = sample.get("compiled_semantic_motion")
        intent_tags = self._build_sample_intent_tags(sample)
        reference_error = self._validate_reference_effect_fields(
            intent_tags=intent_tags,
            compiled_motion=compiled_motion,
        )
        if reference_error:
            return None, reference_error
        if not isinstance(compiled_motion, dict):
            return None, "compiled_semantic_motion_invalid"

        output: dict[str, Any] = {"intent_tags": intent_tags}
        timing = compiled_motion.get("timing")
        duration_ms = timing.get("resolvedDurationMs") if isinstance(timing, dict) else None
        if isinstance(duration_ms, (int, float)) and not isinstance(duration_ms, bool):
            output["duration_hint_ms"] = int(round(float(duration_ms)))
        expression_resource_id = str(
            compiled_motion.get("expressionResourceId") or ""
        ).strip()
        motion_resource_id = str(compiled_motion.get("motionResourceId") or "").strip()
        if expression_resource_id:
            output["expression_resource_id"] = expression_resource_id
        if motion_resource_id:
            output["motion_resource_id"] = motion_resource_id

        if compiled_motion.get("kind") == "pose":
            adjusted_axes = sample.get("adjusted_axes")
            if not isinstance(adjusted_axes, dict) or not adjusted_axes:
                return None, "pose_adjusted_axes_missing"
            filtered_axes = self._filter_example_axes(
                adjusted_axes,
                allowed_axis_ids=allowed_axis_ids,
            )
            axis_levels = self._project_axes_to_levels(
                filtered_axes,
                axis_by_id=axis_by_id,
            )
            if not axis_levels:
                return None, "pose_axis_levels_missing"
            output["axis_levels"] = axis_levels
            return output, ""

        if compiled_motion.get("kind") != "sequence":
            return None, "compiled_semantic_motion_kind_invalid"
        motion_steps, sequence_error = self._project_sequence_motion_steps(
            compiled_motion,
            allowed_axis_ids=allowed_axis_ids,
        )
        if sequence_error:
            return None, sequence_error
        output["motion_steps"] = motion_steps
        return output, ""

    @staticmethod
    def _project_sequence_motion_steps(
        compiled_motion: dict[str, Any],
        *,
        allowed_axis_ids: set[str],
    ) -> tuple[list[dict[str, Any]], str]:
        raw_steps = compiled_motion.get("steps")
        if not isinstance(raw_steps, list) or not 2 <= len(raw_steps) <= 4:
            return [], "sequence_steps_invalid"
        projected_steps: list[dict[str, Any]] = []
        expected_axis_ids: tuple[str, ...] | None = None
        for step in raw_steps:
            if not isinstance(step, dict):
                return [], "sequence_step_invalid"
            diagnostics = step.get("diagnostics")
            trace = diagnostics.get("transformTrace") if isinstance(diagnostics, dict) else None
            raw_levels = trace.get("rawAxisLevels") if isinstance(trace, dict) else None
            if not isinstance(raw_levels, dict):
                return [], "sequence_step_raw_axis_levels_missing"
            axis_levels: dict[str, int] = {}
            for raw_axis_id, raw_level in raw_levels.items():
                axis_id = str(raw_axis_id or "").strip()
                if axis_id not in allowed_axis_ids:
                    continue
                if (
                    isinstance(raw_level, bool)
                    or not isinstance(raw_level, int)
                    or not -4 <= raw_level <= 4
                ):
                    return [], f"sequence_step_axis_level_invalid:{axis_id}"
                axis_levels[axis_id] = raw_level
            if not axis_levels:
                return [], "sequence_step_axis_levels_empty"
            axis_ids = tuple(sorted(axis_levels))
            if expected_axis_ids is None:
                expected_axis_ids = axis_ids
            elif axis_ids != expected_axis_ids:
                return [], "sequence_step_axis_set_mismatch"
            duration_weight = step.get("durationWeight")
            if (
                isinstance(duration_weight, bool)
                or not isinstance(duration_weight, (int, float))
                or int(duration_weight) != duration_weight
                or not 1 <= int(duration_weight) <= 3
            ):
                return [], "sequence_step_duration_weight_invalid"
            projected_steps.append(
                {
                    "axis_levels": axis_levels,
                    "duration_weight": int(duration_weight),
                }
            )
        return projected_steps, ""

    def _ensure_writable(self) -> None:
        if self._storage_path is None:
            raise ValueError("motion_tuning_store_path_unavailable")
        if self.samples_load_error:
            raise ValueError(
                "motion_tuning_store_load_error_active:"
                f"{self.samples_load_error}"
            )

    def _persist_samples(self, samples: list[dict[str, Any]]) -> None:
        if self._storage_path is None:
            raise ValueError("motion_tuning_store_path_unavailable")
        self._storage_path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "schema_version": MOTION_TUNING_STORE_SCHEMA_VERSION,
            "samples": deepcopy(samples),
        }
        temp_path = self._storage_path.with_suffix(
            f"{self._storage_path.suffix}.tmp"
        )
        temp_path.write_text(
            json.dumps(
                payload,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            ),
            encoding="utf-8",
        )
        temp_path.replace(self._storage_path)

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

    def normalize_sample(
        self,
        sample_payload: Any,
        *,
        require_recorded_context: bool = True,
    ) -> dict[str, Any]:
        if not isinstance(sample_payload, dict):
            raise ValueError("motion_tuning_sample_not_object")
        if sample_payload.get("schema_version") != MOTION_TUNING_SAMPLE_SCHEMA_VERSION:
            raise ValueError("motion_tuning_sample_schema_invalid")

        sample_id = str(sample_payload.get("id") or "").strip()
        if not sample_id:
            raise ValueError("motion_tuning_sample_id_required")

        created_at = str(sample_payload.get("created_at") or "").strip()
        if not created_at:
            raise ValueError("motion_tuning_sample_created_at_required")

        source_record_id = str(sample_payload.get("source_record_id") or "").strip()
        if not source_record_id:
            raise ValueError("motion_tuning_sample_source_record_id_required")

        turn_id = str(sample_payload.get("turn_id") or "").strip()
        if not turn_id:
            raise ValueError("motion_tuning_sample_turn_id_required")

        message_id = str(sample_payload.get("message_id") or "").strip()
        if not message_id:
            raise ValueError("motion_tuning_sample_message_id_required")

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
        if compiled_motion["kind"] == "pose":
            adjusted_axes = self._normalize_axes(
                sample_payload.get("adjusted_axes"),
                field_name="adjusted_axes",
                require_non_empty=True,
            )
        else:
            adjusted_axes = self._normalize_axes(
                sample_payload.get("adjusted_axes", {}),
                field_name="adjusted_axes",
                require_non_empty=False,
            )
            if adjusted_axes:
                raise ValueError(
                    "motion_tuning_sample_sequence_adjusted_axes_forbidden"
                )

        user_text = str(sample_payload.get("user_text") or "").strip()
        assistant_text = str(sample_payload.get("assistant_text") or "").strip()
        if require_recorded_context and not user_text:
            raise ValueError("motion_tuning_sample_user_text_missing")
        if require_recorded_context and not assistant_text:
            raise ValueError("motion_tuning_sample_assistant_text_missing")

        normalized_sample = {
            "schema_version": MOTION_TUNING_SAMPLE_SCHEMA_VERSION,
            "id": sample_id,
            "created_at": created_at,
            "source_record_id": source_record_id,
            "turn_id": turn_id,
            "message_id": message_id,
            "model_name": model_name,
            "profile_id": profile_id,
            "profile_revision": profile_revision,
            "emotion_label": str(
                sample_payload.get("emotion_label") or ""
            ).strip()
            or "manual_tuning",
            "user_text": user_text,
            "assistant_text": assistant_text,
            "feedback": str(sample_payload.get("feedback") or "").strip(),
            "tags": self._normalize_tags(sample_payload.get("tags")),
            "enabled_for_llm_reference": bool(
                sample_payload.get("enabled_for_llm_reference")
            ),
            "original_axes": original_axes,
            "compiled_semantic_motion": compiled_motion,
        }
        if compiled_motion["kind"] == "pose":
            normalized_sample["adjusted_axes"] = adjusted_axes
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
            if not isinstance(steps, list) or not 2 <= len(steps) <= 4:
                raise ValueError("motion_tuning_sample_compiled_semantic_motion_steps_invalid")
            expected_axis_ids: tuple[str, ...] | None = None
            for step in steps:
                if not isinstance(step, dict):
                    raise ValueError("motion_tuning_sample_compiled_semantic_motion_step_invalid")
                duration_weight = step.get("durationWeight")
                if (
                    isinstance(duration_weight, bool)
                    or not isinstance(duration_weight, int)
                    or not 1 <= duration_weight <= 3
                ):
                    raise ValueError(
                        "motion_tuning_sample_compiled_semantic_motion_step_weight_invalid"
                    )
                self._validate_compiled_motion_axes(step.get("axes"))
                self._validate_compiled_motion_diagnostics(step.get("diagnostics"))
                axis_ids = self._validate_sequence_step_trace(step)
                if expected_axis_ids is None:
                    expected_axis_ids = axis_ids
                elif axis_ids != expected_axis_ids:
                    raise ValueError(
                        "motion_tuning_sample_compiled_semantic_motion_step_axis_set_mismatch"
                    )
        return deepcopy(motion_payload)

    @staticmethod
    def _validate_performance_curve_hint(hint_payload: Any) -> None:
        if hint_payload is None:
            return
        if (
            not isinstance(hint_payload, dict)
            or hint_payload.get("schema_version") != PERFORMANCE_CURVE_HINT_SCHEMA_VERSION
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
                or axis.get("source") not in {"semantic_axis", "relation_graph"}
            ):
                raise ValueError("motion_tuning_sample_compiled_semantic_motion_axis_invalid")
            axis_ids.add(axis_id)

    @staticmethod
    def _validate_sequence_step_trace(step_payload: dict[str, Any]) -> tuple[str, ...]:
        diagnostics = step_payload.get("diagnostics")
        trace = diagnostics.get("transformTrace") if isinstance(diagnostics, dict) else None
        raw_axis_levels = trace.get("rawAxisLevels") if isinstance(trace, dict) else None
        if not isinstance(raw_axis_levels, dict) or not raw_axis_levels:
            raise ValueError(
                "motion_tuning_sample_compiled_semantic_motion_step_trace_missing"
            )
        for raw_axis_id, raw_level in raw_axis_levels.items():
            axis_id = str(raw_axis_id or "").strip()
            if (
                not axis_id
                or isinstance(raw_level, bool)
                or not isinstance(raw_level, int)
                or not -4 <= raw_level <= 4
            ):
                raise ValueError(
                    "motion_tuning_sample_compiled_semantic_motion_step_trace_invalid"
                )
        return tuple(sorted(str(axis_id).strip() for axis_id in raw_axis_levels))

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
        user_text = str(sample.get("user_text") or "").strip()
        assistant_text = str(sample.get("assistant_text") or "").strip()
        if user_text:
            lines.append(f"User: {user_text}")
        if assistant_text:
            lines.append(f"Assistant: {assistant_text}")
        return "\n".join(lines)

    @staticmethod
    def _truncate_reference_text(value: Any, max_chars: int) -> str:
        normalized = " ".join(str(value or "").split())
        if len(normalized) <= max_chars:
            return normalized
        return normalized[: max_chars - 3].rstrip() + "..."


def _coerce_finite_number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if not isinstance(value, (int, float)):
        return None
    normalized = float(value)
    if normalized != normalized or normalized in {float("inf"), float("-inf")}:
        return None
    return normalized
