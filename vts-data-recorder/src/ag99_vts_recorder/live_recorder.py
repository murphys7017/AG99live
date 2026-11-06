from __future__ import annotations

import asyncio
import threading
import time
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from .client import VTSClient
from .discovery import DiscoveryResult
from .sampler import SamplingProgress, SamplingResult, sample_parameters
from .store import RecorderStore
from .stt import StreamingSTT


@dataclass(frozen=True)
class LiveRecordingResult:
    session_id: int
    take_id: int
    sampling: SamplingResult
    audio_path: Path


def list_microphones() -> list[dict[str, str]]:
    try:
        import sounddevice as sd
    except ImportError as exc:  # pragma: no cover - depends on local install
        raise RuntimeError(
            "sounddevice is required for microphone discovery; install the recording extra"
        ) from exc
    microphones: list[dict[str, str]] = []
    seen_names: set[str] = set()
    for index, device in enumerate(sd.query_devices()):
        if int(device.get("max_input_channels", 0)) <= 0:
            continue
        name = str(device.get("name", "")).strip()
        if not name or name in seen_names:
            continue
        seen_names.add(name)
        microphones.append({"id": str(index), "name": name})
    return microphones


class _MicrophoneProducer:
    def __init__(
        self,
        *,
        sample_rate: int,
        block_samples: int,
        queue: asyncio.Queue[Any],
        loop,
        microphone_name: str | None,
    ):
        self.sample_rate = sample_rate
        self.block_samples = block_samples
        self.queue = queue
        self.loop = loop
        self.microphone_name = microphone_name
        self.stop = threading.Event()
        self.error: BaseException | None = None

    def run(self) -> None:
        try:
            import sounddevice as sd
        except ImportError as exc:  # pragma: no cover - depends on local install
            self.error = RuntimeError(
                "sounddevice is required for live recording; install the recording extra"
            )
            return
        try:
            import numpy as np

            device = _resolve_microphone(sd, self.microphone_name)

            def callback(indata, _frames, _time_info, status) -> None:
                if status:
                    self.error = RuntimeError(f"microphone stream status: {status}")
                samples = np.asarray(indata, dtype=np.float32).reshape(-1).copy()
                if samples.size:
                    self.loop.call_soon_threadsafe(self._enqueue, samples)

            with sd.InputStream(
                samplerate=self.sample_rate,
                channels=1,
                dtype="float32",
                blocksize=self.block_samples,
                device=device,
                callback=callback,
            ):
                while not self.stop.wait(0.1):
                    pass
        except BaseException as exc:  # report to the async owner
            self.error = exc
        finally:
            self.loop.call_soon_threadsafe(self._enqueue, None)

    def _enqueue(self, chunk: Any) -> None:
        try:
            self.queue.put_nowait(chunk)
        except asyncio.QueueFull:
            self.error = RuntimeError("audio capture queue overflow")
            self.stop.set()


async def record_live(
    client: VTSClient,
    *,
    store: RecorderStore,
    endpoint: str,
    discovery: DiscoveryResult,
    vts_version: str | None,
    hz: float,
    seconds: float | None,
    operator_label: str | None,
    subscription_warnings: list[str],
    audio_path: Path,
    stt_model_dir: Path,
    stt_provider: str,
    stt_num_threads: int,
    microphone_name: str | None = None,
    on_progress: Callable[[SamplingProgress], None] | None = None,
) -> LiveRecordingResult:
    from .recorder import _BatchWriter, _take_status, default_target_contract

    session_id = store.create_session(
        endpoint=endpoint,
        requested_hz=hz,
        vts_version=vts_version,
        model_id=discovery.model_id,
        model_name=discovery.model_name,
        target_contract=default_target_contract(),
    )
    take_start_ns = time.monotonic_ns()
    take_id = store.create_take(
        session_id,
        start_monotonic_ns=take_start_ns,
        operator_label=operator_label,
    )
    audio_path.parent.mkdir(parents=True, exist_ok=True)
    store.save_audio_source(
        take_id,
        path=str(audio_path),
        sample_rate=16000,
        channels=1,
    )
    if subscription_warnings:
        store.append_recorder_messages(
            take_id,
            relative_monotonic_ns=0,
            event_type="event_subscription_warning",
            messages=subscription_warnings,
        )

    writer = _BatchWriter(store, take_id=take_id, take_start_monotonic_ns=take_start_ns)
    stop_event = asyncio.Event()
    queue: asyncio.Queue[Any] = asyncio.Queue(maxsize=64)
    producer = _MicrophoneProducer(
        sample_rate=16000,
        block_samples=1600,
        queue=queue,
        loop=asyncio.get_running_loop(),
        microphone_name=microphone_name,
    )
    audio_task: asyncio.Task[None] | None = None
    sampling_task: asyncio.Task[SamplingResult] | None = None
    try:
        stt = StreamingSTT(
            model_dir=stt_model_dir,
            provider=stt_provider,
            num_threads=stt_num_threads,
        )
        audio_task = asyncio.create_task(_consume_audio(
            producer=producer,
            queue=queue,
            stt=stt,
            store=store,
            take_id=take_id,
            take_start_ns=take_start_ns,
            audio_path=audio_path,
            stop_event=stop_event,
        ))
        sampling_task = asyncio.create_task(sample_parameters(
            client,
            hz=hz,
            seconds=seconds,
            known_model_id=discovery.model_id,
            on_progress=on_progress,
            on_batch=writer.append,
            stop_event=stop_event,
        ))
        sampling = await sampling_task
        stop_event.set()
        producer.stop.set()
        await audio_task
        writer.flush()
        errors = [str(error) for error in sampling.report["errors"]]
        if producer.error is not None:
            audio_error = _format_error(producer.error)
            errors.append(audio_error)
            store.append_recorder_messages(
                take_id,
                relative_monotonic_ns=max(time.monotonic_ns() - take_start_ns, 0),
                event_type="audio_capture_error",
                messages=[audio_error],
            )
        if errors:
            sampling.report["errors"] = errors
        stable = bool(sampling.report["environment"]["capture_stable"])
        usable = bool(sampling.report["capture_complete"]) and stable and not producer.error
        termination = str(sampling.report["termination_reason"])
        store.finish_take(
            take_id,
            status=_take_status(termination, capture_usable=usable),
            termination_reason=termination,
            environment_stable=stable,
            duration_ms=round(float(sampling.report["elapsed_seconds"]) * 1000),
            sampling_report=sampling.report,
        )
        store.finish_session(session_id, status=_take_status(termination, capture_usable=usable))
        return LiveRecordingResult(session_id, take_id, sampling, audio_path)
    except BaseException as exc:
        stop_event.set()
        producer.stop.set()
        if sampling_task is not None:
            sampling_task.cancel()
            await asyncio.gather(sampling_task, return_exceptions=True)
        if audio_task is not None:
            await audio_task
        writer.flush()
        store.fail_take(take_id, message=str(exc) or type(exc).__name__)
        store.finish_session(session_id, status="failed")
        raise


async def _consume_audio(
    *,
    producer: _MicrophoneProducer,
    queue: asyncio.Queue[Any],
    stt: StreamingSTT,
    store: RecorderStore,
    take_id: int,
    take_start_ns: int,
    audio_path: Path,
    stop_event: asyncio.Event,
) -> None:
    import numpy as np

    audio_samples = 0
    audio_start_offset_ns: int | None = None
    last_text = ""
    revision = 0
    with wave.open(str(audio_path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(16000)
        producer_task = asyncio.create_task(asyncio.to_thread(producer.run))
        try:
            while True:
                chunk = await queue.get()
                if chunk is None:
                    break
                clipped = np.clip(chunk, -1.0, 1.0)
                pcm = (clipped * 32767).astype(np.int16).tobytes()
                output.writeframes(pcm)
                if audio_start_offset_ns is None:
                    audio_start_offset_ns = max(time.monotonic_ns() - take_start_ns, 0)
                    store.update_audio_start_offset(
                        take_id,
                        start_offset_ns=audio_start_offset_ns,
                    )
                audio_samples += len(chunk)
                text = await asyncio.to_thread(stt.accept, clipped, 16000)
                if text and text != last_text:
                    revision += 1
                    store.append_transcript_event(
                        take_id,
                        kind="partial",
                        text=text,
                        audio_start_offset_ns=audio_start_offset_ns or 0,
                        audio_end_offset_ns=(audio_start_offset_ns or 0)
                        + round(audio_samples / 16000 * 1_000_000_000),
                        emitted_offset_ns=max(time.monotonic_ns() - take_start_ns, 0),
                        revision=revision,
                        model=stt.model_path,
                    )
                    last_text = text
                if stop_event.is_set() and queue.empty():
                    break
            final_text = await asyncio.to_thread(stt.finish)
            if final_text:
                revision += 1
                store.append_transcript_event(
                    take_id,
                    kind="final",
                    text=final_text,
                    audio_start_offset_ns=audio_start_offset_ns or 0,
                    audio_end_offset_ns=(audio_start_offset_ns or 0)
                    + round(audio_samples / 16000 * 1_000_000_000),
                    emitted_offset_ns=max(time.monotonic_ns() - take_start_ns, 0),
                    revision=revision,
                    model=stt.model_path,
                )
        finally:
            producer.stop.set()
            await producer_task


def _resolve_microphone(sounddevice_module, microphone_name: str | None):
    if not microphone_name:
        default_device = sounddevice_module.default.device
        if isinstance(default_device, (tuple, list)):
            return default_device[0]
        return default_device
    requested = microphone_name.casefold().strip()
    devices = sounddevice_module.query_devices()
    matches = []
    for index, device in enumerate(devices):
        if int(device.get("max_input_channels", 0)) <= 0:
            continue
        name = str(device.get("name", "")).casefold().strip()
        if requested == str(index) or (requested == name and not matches):
            matches.append(index)
    if len(matches) != 1:
        available = ", ".join(
            f"{index}:{device.get('name', '')}"
            for index, device in enumerate(devices)
            if int(device.get("max_input_channels", 0)) > 0
        )
        if not matches:
            raise RuntimeError(f"microphone not found: {microphone_name}; available: {available}")
        raise RuntimeError(f"microphone selection is ambiguous: {microphone_name}; available: {available}")
    return matches[0]


def _format_error(error: BaseException) -> str:
    message = str(error).strip()
    return f"{type(error).__name__}: {message}" if message else type(error).__name__
