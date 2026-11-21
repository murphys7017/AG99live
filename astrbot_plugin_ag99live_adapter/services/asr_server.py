"""Run with python -m services.asr_server from the adapter or standalone service directory."""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np

from .remote_asr import FRAME, MAX_FRAME_BYTES
from .streaming_asr import StreamingASR

log = logging.getLogger("ag99live.asr")


async def serve(args: argparse.Namespace) -> None:
    model = StreamingASR(model_dir=str(args.model_dir), num_threads=args.threads)
    loop = asyncio.get_running_loop()
    active = 0

    async def handle(
        reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        nonlocal active
        peer = writer.get_extra_info("peername")[0]
        if peer not in args.allow_client or active >= 8:
            writer.close()
            return
        active += 1
        try:
            session = None
            sample_rate = 0
            total_bytes = 0
            while True:
                async with asyncio.timeout(130):
                    rate, size = FRAME.unpack(await reader.readexactly(FRAME.size))
                    if not 8000 <= rate <= 192000 or (
                        sample_rate and rate != sample_rate
                    ):
                        raise ValueError("invalid sample rate")
                    sample_rate = rate
                    total_bytes += size
                    if (
                        size % 2
                        or size > MAX_FRAME_BYTES
                        or total_bytes > 12 * 1024 * 1024
                    ):
                        raise ValueError("invalid PCM size")
                    pcm = await reader.readexactly(size)
                if pcm:
                    if session is None:
                        session = await loop.run_in_executor(worker, model.new_session)
                    samples = (
                        np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
                    )
                    text = await loop.run_in_executor(
                        worker, session.accept, samples, rate
                    )
                elif session is not None:
                    text = await loop.run_in_executor(worker, session.finish)
                else:
                    text = ""  # A zero-length first frame checks model readiness.
                writer.write((json.dumps(text, ensure_ascii=False) + "\n").encode())
                await writer.drain()
                if not pcm:
                    if total_bytes:
                        log.info(
                            "Completed utterance from %s (%s samples, %s Hz)",
                            peer,
                            total_bytes // 2,
                            rate,
                        )
                    return
        except (asyncio.IncompleteReadError, ConnectionError, TimeoutError):
            pass
        except Exception:
            log.exception("ASR session failed for %s", peer)
        finally:
            active -= 1
            writer.close()

    with ThreadPoolExecutor(max_workers=1) as worker:
        async with await asyncio.start_server(handle, args.host, args.port) as server:
            log.info("Serving %s on %s:%s", model.model_path, args.host, args.port)
            await server.serve_forever()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-dir", type=Path, required=True)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=6006)
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument(
        "--allow-client", action="append", default=["127.0.0.1"], metavar="IP"
    )
    logging.basicConfig(level=logging.INFO)
    asyncio.run(serve(parser.parse_args()))
