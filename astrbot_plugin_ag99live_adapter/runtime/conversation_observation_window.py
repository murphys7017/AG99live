"""Connection-local conversation quiet period and observation invalidation."""

from __future__ import annotations

import asyncio
from time import monotonic
from typing import Callable


class ConversationObservationWindow:
    def __init__(self, is_busy: Callable[[], bool]) -> None:
        self._is_busy = is_busy
        self._last_activity_at = monotonic()
        self._cancel_event = asyncio.Event()
        self.revision = 0
        self._presented_turn: str | None = None
        self._presented_kind = ""
        self._presentation_end: tuple[str, str, float] | None = None

    def note_input(self) -> None:
        """Withdraw all facts sampled before this new user input."""
        self._cancel_event.set()
        self._cancel_event = asyncio.Event()
        self._last_activity_at = monotonic()
        self.revision += 1

    def note_presentation(self, turn_id: str, kind: str) -> None:
        self._presented_turn = turn_id
        self._presented_kind = kind

    def reset(self) -> None:
        self.note_input()
        self._presented_turn = self._presentation_end = None

    def recent_interaction(self) -> dict | None:
        if self._presentation_end is None:
            return None
        kind, outcome, ended_at = self._presentation_end
        return {"kind": kind, "outcome": outcome, "seconds_since_end": int(monotonic() - ended_at)}

    def note_output_finished(self, turn_id: str, result: tuple[bool, str | None]) -> None:
        if self._presented_turn == turn_id:
            success, reason = result
            outcome = "completed" if success else (
                "interrupted" if reason in {"interrupted", "superseded_by_new_user_input", "provider_interrupt"} else "failed"
            )
            self._presentation_end = self._presented_kind, outcome, monotonic()
            self._presented_turn = None
        # Completion starts a fresh quiet period, but must not cancel the very
        # action awaiting this playback acknowledgement.
        self._last_activity_at = monotonic()
        self.revision += 1

    def snapshot(self, wait_seconds: float) -> asyncio.Event | None:
        if self._is_busy() or monotonic() - self._last_activity_at < wait_seconds:
            return None
        return self._cancel_event

    def is_current(
        self, token: asyncio.Event, wait_seconds: float, revision: int
    ) -> bool:
        return (
            not token.is_set()
            and revision == self.revision
            and self.snapshot(wait_seconds) is token
        )
