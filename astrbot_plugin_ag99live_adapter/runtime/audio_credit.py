"""One result's bounded, cumulative desktop PCM admission credit."""

from __future__ import annotations

import asyncio

WINDOW_BYTES = 128 * 1024
WINDOW_FRAMES = 64


class AudioCredit:
    def __init__(self, parent: AudioCredit | None = None) -> None:
        self._parent = parent
        self.sent_bytes = 0
        self.sent_frames = 0
        self.released_bytes = 0
        self.released_frames = 0
        self._closed = False
        self._changed = asyncio.Event()

    def close(self) -> None:
        self._closed = True
        self._changed.set()

    async def reserve(self, size: int) -> None:
        while True:
            if self._closed:
                raise RuntimeError("incremental_audio_credit_closed")
            if (self.sent_bytes + size <= self.released_bytes + WINDOW_BYTES
                and self.sent_frames + 1 <= self.released_frames + WINDOW_FRAMES):
                self.sent_bytes += size
                self.sent_frames += 1
                if self._parent is not None:
                    await self._parent.reserve(size)
                return
            self._changed.clear()
            try:
                await asyncio.wait_for(self._changed.wait(), timeout=30.0)
            except asyncio.TimeoutError as exc:
                raise RuntimeError("incremental_audio_credit_timeout") from exc

    def release(self, byte_count: int, frame_count: int) -> None:
        if (type(byte_count) is not int or type(frame_count) is not int
            or byte_count < 0 or byte_count % 2 or frame_count < 0
            or byte_count > self.sent_bytes or frame_count > self.sent_frames
            or byte_count < 2 * frame_count):
            raise ValueError("incremental_audio_credit_invalid")
        if byte_count <= self.released_bytes and frame_count <= self.released_frames:
            return  # Duplicate/old cumulative acknowledgement; never grant twice.
        if byte_count < self.released_bytes or frame_count < self.released_frames:
            raise ValueError("incremental_audio_credit_inconsistent")
        if self._parent is not None:
            self._parent.release(
                self._parent.released_bytes + byte_count - self.released_bytes,
                self._parent.released_frames + frame_count - self.released_frames,
            )
        self.released_bytes = byte_count
        self.released_frames = frame_count
        self._changed.set()
