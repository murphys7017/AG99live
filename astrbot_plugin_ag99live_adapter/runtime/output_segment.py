from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass, field
from typing import Any, Literal


class OutputSegmentConflictError(ValueError):
    pass


@dataclass
class PendingOutputSegment:
    turn_id: str
    message_id: str
    text: str = ""
    semantic_text: str = ""
    audio_path: str = ""
    images: list[str] = field(default_factory=list)
    motion_payload: dict[str, Any] | None = None
    motion_mode: str = "preview"
    motion_source: str = ""
    curve_request_state: Literal["pending", "started", "disabled", "failed"] = (
        "pending"
    )

    def merge_text(self, value: str) -> None:
        self.text = _merge_unique_text(self.text, value, "text")

    def merge_semantic_text(self, value: str) -> None:
        self.semantic_text = _merge_unique_text(
            self.semantic_text,
            value,
            "semantic_text",
        )

    def merge_audio(self, *, path: str) -> None:
        self.audio_path = _merge_unique_text(self.audio_path, path, "audio_path")

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
        candidate = deepcopy(payload)
        if self.motion_payload is not None and self.motion_payload != candidate:
            raise OutputSegmentConflictError(
                f"output_segment_motion_conflict:{self.message_id}"
            )
        self.motion_payload = candidate
        self.motion_mode = str(mode or "preview").strip() or "preview"
        self.motion_source = str(source or "").strip()


def _merge_unique_text(current: str, incoming: str, field_name: str) -> str:
    normalized = str(incoming or "").strip()
    if not normalized:
        return current
    if current and current != normalized:
        raise OutputSegmentConflictError(
            f"output_segment_{field_name}_conflict"
        )
    return normalized
