"""Single-session state machine for the AG99live V2 adapter."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum


class SessionStage(str, Enum):
    IDLE = "idle"
    THINKING = "thinking"
    SYNTHESIZING = "synthesizing"
    PLAYING = "playing"


@dataclass
class SessionState:
    """Small state container for a single user and a single connection."""

    client_uid: str = "single-client"
    stage: SessionStage = SessionStage.IDLE
    turn_index: int = 0
    last_user_text: str = ""
    waiting_for_playback_complete: bool = False
    output_queue_closed: bool = False
    current_turn_id: str | None = None

    def begin_turn(
        self,
        text: str,
        *,
        turn_id: str,
    ) -> str:
        normalized_turn_id = str(turn_id or "").strip()
        if not normalized_turn_id:
            raise ValueError("turn_id is required when beginning a turn.")
        self.turn_index += 1
        self.last_user_text = text
        self.stage = SessionStage.THINKING
        self.waiting_for_playback_complete = False
        self.output_queue_closed = False
        self.current_turn_id = normalized_turn_id
        return self.current_turn_id

    def mark_synthesizing(self) -> None:
        self.stage = SessionStage.SYNTHESIZING

    def mark_playing(self) -> None:
        self.stage = SessionStage.PLAYING
        self.waiting_for_playback_complete = True

    def mark_output_queue_closed(self) -> bool:
        if self.output_queue_closed:
            return False
        self.output_queue_closed = True
        return True

    def mark_playback_complete(self) -> None:
        self.waiting_for_playback_complete = False
        self.output_queue_closed = False
        self.stage = SessionStage.IDLE
        self.current_turn_id = None

    def reset_to_idle(self) -> None:
        self.waiting_for_playback_complete = False
        self.output_queue_closed = False
        self.stage = SessionStage.IDLE
        self.current_turn_id = None
