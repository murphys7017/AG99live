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

    def note_input(self) -> None:
        """Withdraw all facts sampled before this new user input."""
        self._cancel_event.set()
        self._cancel_event = asyncio.Event()
        self._last_activity_at = monotonic()
        self.revision += 1

    def note_output_finished(self) -> None:
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
