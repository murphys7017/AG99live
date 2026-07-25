from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass, field
from typing import Any


class OutputSegmentConflictError(ValueError):
    pass


@dataclass
class PendingOutputSegment:
    turn_id: str
    message_id: str
    text: str = ""
    semantic_text: str = ""
    audio_path: str = ""
    audio_failure_reason: str = ""
    tts_request_id: str = ""
    tts_status: str = ""
    images: list[str] = field(default_factory=list)
    motion_payload: dict[str, Any] | None = None
    motion_expected: bool = False
    motion_failure_reason: str = ""
    motion_mode: str = "preview"
    motion_source: str = ""
    performance_curve_request_id: str = ""

    def merge_text(self, value: str) -> None:
        self.text = _merge_unique_text(self.text, value, "text")

    def merge_semantic_text(self, value: str) -> None:
        self.semantic_text = _merge_unique_text(
            self.semantic_text,
            value,
            "semantic_text",
        )

    def merge_audio(self, *, path: str) -> None:
        if self.audio_failure_reason:
            raise OutputSegmentConflictError(
                f"output_segment_audio_state_conflict:{self.message_id}"
            )
        self.audio_path = _merge_unique_text(self.audio_path, path, "audio_path")

    def merge_tts_terminal_state(
        self,
        *,
        request_id: str,
        status: str,
        failure_code: str,
    ) -> None:
        normalized_request_id = str(request_id or "").strip()
        normalized_status = str(status or "").strip().lower()
        normalized_failure_code = str(failure_code or "").strip()
        if not normalized_request_id:
            raise ValueError("output_segment_tts_request_id_missing")
        if normalized_status not in {"succeeded", "failed"}:
            raise ValueError(f"output_segment_tts_terminal_status_invalid:{normalized_status}")
        if normalized_status == "failed" and not normalized_failure_code:
            raise ValueError("output_segment_tts_failure_code_missing")
        if normalized_status == "succeeded" and normalized_failure_code:
            raise ValueError("output_segment_tts_failure_code_without_failure")
        self.tts_request_id = _merge_unique_text(
            self.tts_request_id,
            normalized_request_id,
            "tts_request_id",
        )
        self.tts_status = _merge_unique_text(
            self.tts_status,
            normalized_status,
            "tts_status",
        )
        if normalized_failure_code:
            self.audio_failure_reason = _merge_unique_text(
                self.audio_failure_reason,
                normalized_failure_code,
                "audio_failure_reason",
            )

    def merge_images(self, values: list[str]) -> None:
        for value in values:
            normalized = str(value or "").strip()
            if normalized and normalized not in self.images:
                self.images.append(normalized)

    def merge_motion(
        self,
        *,
        payload: dict[str, Any],
        mode: str,
        source: str,
    ) -> None:
        if self.motion_failure_reason:
            raise OutputSegmentConflictError(
                f"output_segment_motion_state_conflict:{self.message_id}"
            )
        candidate = deepcopy(payload)
        if self.motion_payload is not None and self.motion_payload != candidate:
            raise OutputSegmentConflictError(
                f"output_segment_motion_conflict:{self.message_id}"
            )
        self.motion_payload = candidate
        self.motion_mode = str(mode or "preview").strip() or "preview"
        self.motion_source = str(source or "").strip()

    def require_motion(self) -> None:
        self.motion_expected = True

    def merge_motion_failure(self, reason: str) -> None:
        if self.motion_payload is not None:
            raise OutputSegmentConflictError(
                f"output_segment_motion_state_conflict:{self.message_id}"
            )
        self.motion_failure_reason = _merge_unique_text(
            self.motion_failure_reason,
            reason,
            "motion_failure_reason",
        )

    def bind_performance_curve_request(self, request_id: str) -> None:
        self.performance_curve_request_id = _merge_unique_text(
            self.performance_curve_request_id,
            request_id,
            "performance_curve_request_id",
        )


def _merge_unique_text(current: str, incoming: str, field_name: str) -> str:
    normalized = str(incoming or "").strip()
    if not normalized:
        return current
    if current and current != normalized:
        raise OutputSegmentConflictError(
            f"output_segment_{field_name}_conflict"
        )
    return normalized
