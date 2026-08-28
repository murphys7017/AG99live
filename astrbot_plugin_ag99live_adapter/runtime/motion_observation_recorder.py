"""MotionLab observation and prompt-history projection for one adapter session."""

from __future__ import annotations

from typing import Any

from astrbot.api import logger

from ..motion.motion_intent import resolve_selected_semantic_axis_profile
from ..motion.observation import record_motion_observation
from ..protocol.schema_versions import MOTION_INTENT_V4_SCHEMA_VERSION


MAX_PROMPT_MOTION_HISTORY = 4


class MotionObservationRecorder:
    """Own observation projections without owning turn or playback state."""

    def __init__(self, *, runtime_state: Any, session_state: Any, chat_buffer: Any) -> None:
        self.runtime_state = runtime_state
        self.session_state = session_state
        self.chat_buffer = chat_buffer
        self._prompt_motion_history: list[dict[str, Any]] = []

    def reset(self) -> None:
        self._prompt_motion_history.clear()

    def get_prompt_motion_history(self) -> list[dict[str, Any]]:
        history: list[dict[str, Any]] = []
        for snapshot in self._prompt_motion_history:
            if not isinstance(snapshot, dict):
                continue
            cloned_snapshot = dict(snapshot)
            axis_levels = snapshot.get("axis_levels")
            motion_steps = snapshot.get("motion_steps")
            intent_tags = snapshot.get("intent_tags")
            if isinstance(axis_levels, dict):
                cloned_snapshot["axis_levels"] = dict(axis_levels)
            if isinstance(motion_steps, list):
                cloned_snapshot["motion_steps"] = [
                    {
                        **step,
                        "axis_levels": dict(step.get("axis_levels") or {}),
                    }
                    for step in motion_steps
                    if isinstance(step, dict)
                ]
            if isinstance(intent_tags, list):
                cloned_snapshot["intent_tags"] = list(intent_tags)
            history.append(cloned_snapshot)
        return history

    def record_prompt_motion_snapshot(
        self,
        *,
        motion_payload: dict[str, Any],
        source: str,
    ) -> None:
        if (
            str(motion_payload.get("schema_version") or "").strip()
            != MOTION_INTENT_V4_SCHEMA_VERSION
        ):
            return
        axis_levels = motion_payload.get("axis_levels")
        motion_steps = motion_payload.get("motion_steps")
        has_levels = isinstance(axis_levels, dict) and bool(axis_levels)
        has_steps = isinstance(motion_steps, list) and bool(motion_steps)
        expression_resource_id = str(
            motion_payload.get("expression_resource_id") or ""
        ).strip()
        motion_resource_id = str(
            motion_payload.get("motion_resource_id") or ""
        ).strip()
        has_resource = bool(expression_resource_id or motion_resource_id)
        if "axes" in motion_payload or (has_levels == has_steps and not has_resource):
            return
        normalized_levels = dict(axis_levels) if isinstance(axis_levels, dict) else {}

        intent_tags = motion_payload.get("intent_tags")
        normalized_tags = []
        if isinstance(intent_tags, list):
            normalized_tags = [
                str(item).strip()
                for item in intent_tags
                if str(item).strip()
            ][:6]

        snapshot = {
            "schema_version": MOTION_INTENT_V4_SCHEMA_VERSION,
            "source": str(source or "").strip(),
            "intent_tags": normalized_tags,
        }
        if normalized_levels:
            snapshot["axis_levels"] = normalized_levels
        if isinstance(motion_steps, list):
            snapshot["motion_steps"] = [
                {
                    "axis_levels": dict(step.get("axis_levels") or {}),
                    "duration_weight": step.get("duration_weight"),
                }
                for step in motion_steps
                if isinstance(step, dict)
            ]
        snapshot["expression_resource_id"] = expression_resource_id
        snapshot["motion_resource_id"] = motion_resource_id
        self._prompt_motion_history.append(snapshot)
        del self._prompt_motion_history[:-MAX_PROMPT_MOTION_HISTORY]

    def record_motion_lab_raw_event(
        self,
        *,
        event_type: str,
        turn_id: str,
        frontend_turn_id: str | None = None,
        message_id: str | None = None,
        source_route: str = "",
        phase: str = "",
        user_text: str = "",
        assistant_text: str = "",
        payload_kind: str = "",
        raw: dict[str, Any] | None = None,
    ) -> bool:
        profile = None
        try:
            profile = resolve_selected_semantic_axis_profile(
                runtime_state=self.runtime_state,
            )
        except Exception:  # noqa: BLE001
            logger.exception(
                "MotionLab profile resolution failed: event_type=%s turn_id=%s",
                event_type,
                turn_id,
            )
        return record_motion_observation(
            getattr(self.runtime_state, "motion_lab_recorder", None),
            event_type=event_type,
            conversation_uid=getattr(self.session_state, "client_uid", None),
            turn_id=str(turn_id or "").strip(),
            frontend_turn_id=frontend_turn_id,
            message_id=message_id,
            source_route=source_route,
            phase=phase,
            model_name=str((profile or {}).get("model_id") or "").strip(),
            profile_id=str((profile or {}).get("profile_id") or "").strip(),
            profile_revision=(profile or {}).get("revision"),
            user_text=user_text,
            assistant_text=assistant_text,
            payload_kind=payload_kind,
            raw=raw or {},
        )

    def motion_lab_chat_context(self) -> list[dict[str, str]]:
        to_list = getattr(self.chat_buffer, "to_list", None)
        if not callable(to_list):
            return []
        try:
            value = to_list()
        except Exception:  # noqa: BLE001
            logger.exception("MotionLab chat context snapshot failed")
            return []
        return value if isinstance(value, list) else []

    def record_motion_slot(self, motion_slot: dict[str, Any], *, source: str) -> None:
        payload = motion_slot.get("payload")
        if isinstance(payload, dict):
            self.record_prompt_motion_snapshot(
                motion_payload=payload,
                source=source,
            )
