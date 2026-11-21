"""One utterance per TCP connection. Frames carry a sample rate and PCM16LE byte count.

An empty frame finalizes the utterance. Every frame receives one UTF-8 JSON
string followed by LF, including frames whose transcription is still empty.
"""

from __future__ import annotations

import asyncio
import json
import struct
from urllib.parse import urlsplit

FRAME = struct.Struct("!II")
MAX_FRAME_BYTES = 64 * 1024


def parse_asr_endpoint(endpoint: str) -> tuple[str, int]:
    address = urlsplit("//" + endpoint)
    host, port = address.hostname, address.port
    if (
        not host
        or not port
        or address.username is not None
        or any(c.isspace() or c in "/?#\\" for c in endpoint)
    ):
        raise ValueError("Expected streaming ASR host:port")
    return host, port


class RemoteASRSession:
    def __init__(self, endpoint: str) -> None:
        self.endpoint = endpoint
        self.host, self.port = parse_asr_endpoint(endpoint)
        self.reader: asyncio.StreamReader | None = None
        self.writer: asyncio.StreamWriter | None = None
        self.closed = False
        self.final_text = ""
        self.sample_rate = 16000

    async def _connect(self) -> None:
        reader, writer = await asyncio.open_connection(self.host, self.port)
        if self.closed:
            writer.close()
            raise ConnectionAbortedError("Streaming ASR capture ended")
        self.reader, self.writer = reader, writer

    async def check_ready(self) -> None:
        try:
            await self._exchange(b"")
        finally:
            self.close()

    async def _exchange(self, pcm: bytes) -> str:
        try:
            async with asyncio.timeout(5):
                if self.closed:
                    raise ConnectionAbortedError("Streaming ASR capture ended")
                if self.writer is None:
                    await self._connect()
                assert self.writer is not None and self.reader is not None
                self.writer.write(FRAME.pack(self.sample_rate, len(pcm)) + pcm)
                await self.writer.drain()
                line = await self.reader.readline()
                if not line:
                    raise ConnectionError("Streaming ASR server disconnected")
                text = json.loads(line)
                if not isinstance(text, str):
                    raise ValueError("Invalid streaming ASR response")
                return text
        except (Exception, asyncio.CancelledError):
            self.close()
            raise

    async def accept(self, pcm: bytes, sample_rate: int) -> str:
        self.sample_rate = sample_rate
        return await self._exchange(pcm)

    async def finish(self) -> str:
        if self.writer is not None:
            try:
                self.final_text = await self._exchange(b"")
            finally:
                self.close()
        return self.final_text

    def close(self) -> None:
        self.closed = True
        if self.writer is not None:
            self.writer.close()
            self.writer = None
            self.reader = None

    def reset(self) -> None:
        self.close()
        self.closed = False
        self.final_text = ""
