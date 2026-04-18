"""Single-session state machine for the initial desktop-pet adapter."""

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

    def begin_turn(self, text: str) -> None:
        self.turn_index += 1
        self.last_user_text = text
        self.stage = SessionStage.THINKING
        self.waiting_for_playback_complete = False

    def mark_synthesizing(self) -> None:
        self.stage = SessionStage.SYNTHESIZING

    def mark_playing(self) -> None:
        self.stage = SessionStage.PLAYING
        self.waiting_for_playback_complete = True

    def mark_playback_complete(self) -> None:
        self.waiting_for_playback_complete = False
        self.stage = SessionStage.IDLE

    def reset_to_idle(self) -> None:
        self.waiting_for_playback_complete = False
        self.stage = SessionStage.IDLE

