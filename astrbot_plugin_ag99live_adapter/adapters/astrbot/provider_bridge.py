"""Thin AstrBot-to-neutral Provider bridges.

The bridge owns no Turn, Segment, WebSocket, or frontend state. It adapts
callbacks supplied by the current AstrBot composition root to the neutral
contracts in ``providers.contracts``. The existing runtime can adopt these
bridges incrementally without changing its current output path.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import Any, TypeAlias

from ...providers.contracts import (
    AudioArtifact,
    AvatarOutputPort,
    ControlEvent,
    ConversationEvent,
    ConversationInput,
    ConversationListener,
    ConversationProvider,
    MotionProvider,
    MotionEventListener,
    MotionLifecycleEvent,
    MotionOrigin,
    MotionRequest,
    MotionResult,
    OutputSegmentEnvelope,
    PartialTranscriptListener,
    ProviderFailure,
    ProtocolError,
    SttProvider,
    SttResult,
    SttSessionOptions,
    TtsProvider,
    TtsEventListener,
    TtsLifecycleEvent,
    TtsRequest,
    TtsResult,
    Unsubscribe,
    TtsEventKind,
    MotionEventKind,
)
from ...protocol.builder import build_control_error, build_output_segment
from ...protocol.constants import SOURCE_ADAPTER
from ...protocol.parser import build_message_envelope


BridgeResult: TypeAlias = Awaitable[None] | None
ConversationSubmit: TypeAlias = Callable[[ConversationInput], Awaitable[None]]
ConversationInterrupt: TypeAlias = Callable[[str | None], Awaitable[None]]
ConversationClose: TypeAlias = Callable[[], Awaitable[None]]
SttRecognize: TypeAlias = Callable[
    [str, bytes, SttSessionOptions], Awaitable[SttResult | str]
]
TtsSynthesize: TypeAlias = Callable[[TtsRequest], Awaitable[TtsResult | AudioArtifact]]
TtsCancel: TypeAlias = Callable[[str], Awaitable[None]]
MotionGenerate: TypeAlias = Callable[
    [MotionRequest], Awaitable[MotionResult | Mapping[str, Any]]
]
MotionCancel: TypeAlias = Callable[[str], Awaitable[None]]
SendJson: TypeAlias = Callable[[dict[str, Any]], Awaitable[bool]]


@dataclass(frozen=True)
class ProviderBridgeCallbacks:
    """Current-host callbacks used to construct the neutral bridge.

    The callbacks are deliberately narrow. The AstrBot composition root may
    close over its existing event, provider and media services, while the
    bridge exposes only neutral request/result objects to the Orchestrator.
    """

    submit_conversation: ConversationSubmit
    interrupt_conversation: ConversationInterrupt
    close_conversation: ConversationClose
    recognize_audio: SttRecognize
    synthesize_tts: TtsSynthesize
    cancel_tts: TtsCancel
    generate_motion: MotionGenerate
    cancel_motion: MotionCancel
    send_json: SendJson


class ProviderBridgeError(RuntimeError):
    """Runtime exception carrying a neutral structured ProviderFailure."""

    def __init__(self, failure: ProviderFailure) -> None:
        self.failure = failure
        super().__init__(failure.message)


class _AsyncEventHub:
    def __init__(self) -> None:
        self._listeners: set[Callable[[Any], BridgeResult]] = set()

    def subscribe(self, listener: Callable[[Any], BridgeResult]) -> Unsubscribe:
        self._listeners.add(listener)
        active = True

        def unsubscribe() -> None:
            nonlocal active
            if not active:
                return
            active = False
            self._listeners.discard(listener)

        return unsubscribe

    async def publish(self, event: Any) -> None:
        for listener in tuple(self._listeners):
            result = listener(event)
            if asyncio.iscoroutine(result) or isinstance(result, Awaitable):
                await result

    def clear(self) -> None:
        self._listeners.clear()


class AstrBotConversationProvider(ConversationProvider):
    """Adapt current AstrBot input submission and lifecycle events."""

    def __init__(
        self,
        *,
        submit_message: ConversationSubmit,
        interrupt: ConversationInterrupt,
        close: ConversationClose,
    ) -> None:
        self._submit_message = submit_message
        self._interrupt = interrupt
        self._close = close
        self._events = _AsyncEventHub()

    async def send_message(self, request: ConversationInput) -> None:
        await self._submit_message(request)

    async def interrupt(self, turn_id: str | None = None) -> None:
        await self._interrupt(turn_id)

    async def close(self) -> None:
        await self._close()
        self._events.clear()

    def subscribe(self, listener: ConversationListener) -> Unsubscribe:
        return self._events.subscribe(listener)

    async def publish_event(self, event: ConversationEvent) -> None:
        """Publish a normalized fact from an AstrBot lifecycle hook."""

        await self._events.publish(event)


class AstrBotSttProvider(SttProvider):
    """Adapt the current host STT callback with per-stream buffering.

    The bridge is intentionally not wired into ``SpeechIngressService`` yet.
    Until the Orchestrator migration, the existing local sherpa path and
    AstrBot review path remain authoritative. The bounded buffer documents the
    ownership/backpressure contract for the next integration step.
    """

    def __init__(
        self,
        *,
        recognize_audio: SttRecognize,
        max_buffer_bytes: int = 12 * 1024 * 1024,
    ) -> None:
        if isinstance(max_buffer_bytes, bool) or max_buffer_bytes <= 0:
            raise ValueError("stt_bridge_buffer_limit_invalid")
        self._recognize_audio = recognize_audio
        self._max_buffer_bytes = max_buffer_bytes
        self._sessions: dict[str, tuple[bytearray, SttSessionOptions]] = {}
        self._partial_listeners: set[PartialTranscriptListener] = set()
        self._final_listeners: set[Callable[[SttResult], BridgeResult]] = set()

    async def start_session(
        self,
        stream_id: str,
        options: SttSessionOptions | None = None,
    ) -> None:
        normalized_stream_id = _require_id(stream_id, "stream_id")
        if normalized_stream_id in self._sessions:
            raise RuntimeError("stt_stream_already_started")
        self._sessions[normalized_stream_id] = (
            bytearray(),
            options or SttSessionOptions(),
        )

    async def push_audio(self, stream_id: str, chunk: bytes) -> None:
        normalized_stream_id = _require_id(stream_id, "stream_id")
        session = self._sessions.get(normalized_stream_id)
        if session is None:
            raise RuntimeError("stt_stream_not_started")
        if not isinstance(chunk, bytes):
            raise TypeError("stt_audio_chunk_must_be_bytes")
        buffer, options = session
        if len(buffer) + len(chunk) > self._max_buffer_bytes:
            raise ProviderBridgeError(
                ProviderFailure(
                    provider="astrbot.stt",
                    request_id=normalized_stream_id,
                    code="stt_buffer_limit_exceeded",
                    message="The STT stream exceeded its bounded audio buffer.",
                )
            )
        buffer.extend(chunk)
        self._sessions[normalized_stream_id] = (buffer, options)

    async def finish_session(self, stream_id: str) -> SttResult:
        normalized_stream_id = _require_id(stream_id, "stream_id")
        session = self._sessions.pop(normalized_stream_id, None)
        if session is None:
            raise RuntimeError("stt_stream_not_started")
        buffer, options = session
        try:
            result = await self._recognize_audio(
                normalized_stream_id,
                bytes(buffer),
                options,
            )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            raise ProviderBridgeError(
                ProviderFailure(
                    provider="astrbot.stt",
                    request_id=normalized_stream_id,
                    code="stt_recognition_failed",
                    message=str(exc) or "AstrBot STT recognition failed.",
                )
            ) from exc
        normalized = (
            result
            if isinstance(result, SttResult)
            else SttResult(stream_id=normalized_stream_id, text=str(result or ""))
        )
        if normalized.stream_id != normalized_stream_id:
            raise ProviderBridgeError(
                ProviderFailure(
                    provider="astrbot.stt",
                    request_id=normalized_stream_id,
                    code="stt_stream_identity_conflict",
                    message="AstrBot STT returned a result for another stream.",
                )
            )
        await _publish_listeners(self._final_listeners, normalized)
        return normalized

    async def cancel_session(self, stream_id: str) -> None:
        normalized_stream_id = _require_id(stream_id, "stream_id")
        self._sessions.pop(normalized_stream_id, None)

    async def close(self) -> None:
        self._sessions.clear()
        self._partial_listeners.clear()
        self._final_listeners.clear()

    def on_partial(self, listener: PartialTranscriptListener) -> Unsubscribe:
        self._partial_listeners.add(listener)
        return _set_unsubscriber(self._partial_listeners, listener)

    def on_final(self, listener: Callable[[SttResult], BridgeResult]) -> Unsubscribe:
        self._final_listeners.add(listener)
        return _set_unsubscriber(self._final_listeners, listener)

    async def publish_partial(self, stream_id: str, text: str) -> None:
        normalized_stream_id = _require_id(stream_id, "stream_id")
        await _publish_listeners(
            self._partial_listeners,
            (normalized_stream_id, str(text or "")),
        )


class AstrBotTtsProvider(TtsProvider):
    """Adapt the current AstrBot TTS lifecycle to a canonical artifact result."""

    def __init__(
        self,
        *,
        synthesize: TtsSynthesize,
        cancel: TtsCancel,
    ) -> None:
        self._synthesize = synthesize
        self._cancel = cancel
        self._events = _AsyncEventHub()
        self._active_tasks: dict[str, asyncio.Task[Any]] = {}

    async def synthesize(self, request: TtsRequest) -> TtsResult:
        current_task = asyncio.current_task()
        if current_task is not None:
            self._active_tasks[request.request_id] = current_task
        try:
            await self.publish_event(
                TtsLifecycleEvent(
                    request_id=request.request_id,
                    kind=TtsEventKind.REQUESTED,
                    turn_id=request.turn_id,
                    message_id=request.message_id,
                )
            )
        except Exception:
            self._active_tasks.pop(request.request_id, None)
            raise
        try:
            result = await self._synthesize(request)
            if isinstance(result, TtsResult):
                normalized = result
            elif isinstance(result, AudioArtifact):
                normalized = TtsResult(request_id=request.request_id, artifact=result)
            else:
                raise TypeError("astrbot_tts_bridge_result_invalid")
            if normalized.request_id != request.request_id:
                raise ValueError("astrbot_tts_bridge_request_id_conflict")
        except asyncio.CancelledError:
            await self.publish_event(
                TtsLifecycleEvent(
                    request_id=request.request_id,
                    kind=TtsEventKind.CANCELLED,
                    turn_id=request.turn_id,
                    message_id=request.message_id,
                    reason="cancelled",
                )
            )
            raise
        except Exception as exc:
            await self.publish_event(
                TtsLifecycleEvent(
                    request_id=request.request_id,
                    kind=TtsEventKind.FAILED,
                    turn_id=request.turn_id,
                    message_id=request.message_id,
                    reason=str(exc) or "tts_generation_failed",
                )
            )
            raise
        finally:
            self._active_tasks.pop(request.request_id, None)
        await self.publish_event(
            TtsLifecycleEvent(
                request_id=normalized.request_id,
                kind=TtsEventKind.READY,
                turn_id=request.turn_id,
                message_id=request.message_id,
                artifact=normalized.artifact,
            )
        )
        return normalized

    async def cancel(self, request_id: str) -> None:
        normalized_request_id = _require_id(request_id, "tts_request_id")
        await self._cancel(normalized_request_id)
        task = self._active_tasks.get(normalized_request_id)
        if task is not None and task is not asyncio.current_task() and not task.done():
            task.cancel()
            return
        await self.publish_event(
            TtsLifecycleEvent(
                request_id=normalized_request_id,
                kind=TtsEventKind.CANCELLED,
                reason="cancelled",
            )
        )

    async def close(self) -> None:
        tasks = tuple(self._active_tasks.values())
        self._active_tasks.clear()
        for task in tasks:
            if not task.done():
                task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self._events.clear()

    def subscribe(self, listener: TtsEventListener) -> Unsubscribe:
        return self._events.subscribe(listener)

    async def publish_event(self, event: TtsLifecycleEvent) -> None:
        await self._events.publish(event)


class AstrBotMotionProvider(MotionProvider):
    """Adapt current Persona/independent motion generation callbacks."""

    def __init__(
        self,
        *,
        generate: MotionGenerate,
        cancel: MotionCancel,
    ) -> None:
        self._generate = generate
        self._cancel = cancel
        self._events = _AsyncEventHub()
        self._request_origins: dict[str, MotionOrigin] = {}
        self._active_tasks: dict[str, asyncio.Task[Any]] = {}

    async def generate(self, request: MotionRequest) -> MotionResult:
        self._request_origins[request.request_id] = request.origin
        current_task = asyncio.current_task()
        if current_task is not None:
            self._active_tasks[request.request_id] = current_task
        try:
            await self.publish_event(
                MotionLifecycleEvent(
                    request_id=request.request_id,
                    kind=MotionEventKind.REQUESTED,
                    origin=request.origin,
                    turn_id=request.turn_id,
                    message_id=request.message_id,
                )
            )
        except Exception:
            self._active_tasks.pop(request.request_id, None)
            self._request_origins.pop(request.request_id, None)
            raise
        try:
            result = await self._generate(request)
            if isinstance(result, MotionResult):
                if result.origin is not request.origin:
                    raise ValueError("astrbot_motion_bridge_origin_conflict")
                if result.request_id != request.request_id:
                    raise ValueError("astrbot_motion_bridge_request_id_conflict")
                normalized = result
            elif isinstance(result, Mapping):
                normalized = MotionResult(
                    request_id=request.request_id,
                    origin=request.origin,
                    payload=dict(result),
                )
            else:
                raise TypeError("astrbot_motion_bridge_result_invalid")
        except asyncio.CancelledError:
            self._request_origins.pop(request.request_id, None)
            await self.publish_event(
                MotionLifecycleEvent(
                    request_id=request.request_id,
                    kind=MotionEventKind.CANCELLED,
                    origin=request.origin,
                    turn_id=request.turn_id,
                    message_id=request.message_id,
                    reason="cancelled",
                )
            )
            raise
        except Exception as exc:
            self._request_origins.pop(request.request_id, None)
            await self.publish_event(
                MotionLifecycleEvent(
                    request_id=request.request_id,
                    kind=MotionEventKind.FAILED,
                    origin=request.origin,
                    turn_id=request.turn_id,
                    message_id=request.message_id,
                    reason=str(exc) or "motion_generation_failed",
                )
            )
            raise
        finally:
            self._active_tasks.pop(request.request_id, None)
        await self.publish_event(
            MotionLifecycleEvent(
                request_id=normalized.request_id,
                kind=MotionEventKind.READY,
                origin=normalized.origin,
                turn_id=request.turn_id,
                message_id=request.message_id,
                payload=normalized.payload,
            )
        )
        self._request_origins.pop(request.request_id, None)
        return normalized

    async def cancel(self, request_id: str) -> None:
        normalized_request_id = _require_id(request_id, "motion_request_id")
        await self._cancel(normalized_request_id)
        task = self._active_tasks.get(normalized_request_id)
        if task is not None and task is not asyncio.current_task() and not task.done():
            task.cancel()
            return
        origin = self._request_origins.pop(normalized_request_id, MotionOrigin.TURN)
        await self.publish_event(
            MotionLifecycleEvent(
                request_id=normalized_request_id,
                kind=MotionEventKind.CANCELLED,
                origin=origin,
                reason="cancelled",
            )
        )

    async def close(self) -> None:
        tasks = tuple(self._active_tasks.values())
        self._active_tasks.clear()
        for task in tasks:
            if not task.done():
                task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self._request_origins.clear()
        self._events.clear()

    def subscribe(self, listener: MotionEventListener) -> Unsubscribe:
        return self._events.subscribe(listener)

    async def publish_event(self, event: MotionLifecycleEvent) -> None:
        await self._events.publish(event)


class AstrBotAvatarOutputPort(AvatarOutputPort):
    """Publish neutral output facts through the existing AstrBot WS sender."""

    def __init__(self, *, send_json: SendJson) -> None:
        self._send_json = send_json

    async def publish_segment(self, segment: OutputSegmentEnvelope) -> None:
        payload = dict(segment.payload)
        required = ("text", "audio", "motion", "speech", "images")
        if any(key not in payload for key in required):
            raise ProviderBridgeError(
                ProviderFailure(
                    provider="astrbot.avatar_output",
                    request_id=segment.message_id,
                    code="output_segment_payload_incomplete",
                    message="The neutral output segment payload is incomplete.",
                    turn_id=segment.turn_id,
                    message_id=segment.message_id,
                )
            )
        envelope = build_output_segment(
            turn_id=segment.turn_id,
            message_id=segment.message_id,
            sequence=segment.sequence,
            text=payload["text"],
            audio=payload["audio"],
            motion=payload["motion"],
            speech=payload["speech"],
            images=list(payload["images"]),
            speaker_name=str(payload.get("speaker_name") or ""),
            avatar=str(payload.get("avatar") or ""),
        )
        sent = await self._send_json(envelope)
        if not sent:
            raise ProviderBridgeError(
                ProviderFailure(
                    provider="astrbot.avatar_output",
                    request_id=segment.message_id,
                    code="output_segment_send_failed",
                    message="The existing AstrBot WebSocket sender rejected the segment.",
                    turn_id=segment.turn_id,
                    message_id=segment.message_id,
                )
            )

    async def publish_control(self, event: ControlEvent) -> None:
        envelope = build_message_envelope(
            event.type,
            source=SOURCE_ADAPTER,
            turn_id=event.turn_id,
            payload=dict(event.payload),
        )
        sent = await self._send_json(envelope)
        if not sent:
            raise ProviderBridgeError(
                ProviderFailure(
                    provider="astrbot.avatar_output",
                    request_id=event.type,
                    code="control_event_send_failed",
                    message="The existing AstrBot WebSocket sender rejected the control event.",
                    turn_id=event.turn_id,
                )
            )

    async def publish_error(self, error: ProtocolError) -> None:
        envelope = build_control_error(
            turn_id=error.turn_id,
            message=error.message,
        )
        sent = await self._send_json(envelope)
        if not sent:
            raise ProviderBridgeError(
                ProviderFailure(
                    provider="astrbot.avatar_output",
                    request_id=error.code,
                    code="protocol_error_send_failed",
                    message="The existing AstrBot WebSocket sender rejected the error.",
                    turn_id=error.turn_id,
                )
            )


@dataclass(frozen=True)
class AstrBotProviderBridge:
    """All four neutral Provider ports backed by current AstrBot callbacks."""

    conversation: AstrBotConversationProvider
    stt: AstrBotSttProvider
    tts: AstrBotTtsProvider
    motion: AstrBotMotionProvider
    avatar_output: AstrBotAvatarOutputPort

    @classmethod
    def from_callbacks(
        cls,
        callbacks: ProviderBridgeCallbacks,
        *,
        avatar_output: AstrBotAvatarOutputPort | None = None,
    ) -> "AstrBotProviderBridge":
        return cls(
            conversation=AstrBotConversationProvider(
                submit_message=callbacks.submit_conversation,
                interrupt=callbacks.interrupt_conversation,
                close=callbacks.close_conversation,
            ),
            stt=AstrBotSttProvider(recognize_audio=callbacks.recognize_audio),
            tts=AstrBotTtsProvider(
                synthesize=callbacks.synthesize_tts,
                cancel=callbacks.cancel_tts,
            ),
            motion=AstrBotMotionProvider(
                generate=callbacks.generate_motion,
                cancel=callbacks.cancel_motion,
            ),
            avatar_output=avatar_output
            or AstrBotAvatarOutputPort(send_json=callbacks.send_json),
        )


def _require_id(value: str, field_name: str) -> str:
    normalized = str(value or "").strip()
    if not normalized:
        raise ValueError(f"{field_name}_required")
    return normalized


async def _publish_listeners(listeners: set[Callable[..., BridgeResult]], value: Any) -> None:
    for listener in tuple(listeners):
        if isinstance(value, tuple):
            result = listener(*value)
        else:
            result = listener(value)
        if asyncio.iscoroutine(result) or isinstance(result, Awaitable):
            await result


def _set_unsubscriber(listeners: set[Any], listener: Any) -> Unsubscribe:
    active = True

    def unsubscribe() -> None:
        nonlocal active
        if not active:
            return
        active = False
        listeners.discard(listener)

    return unsubscribe


__all__ = [
    "AstrBotConversationProvider",
    "AstrBotMotionProvider",
    "AstrBotProviderBridge",
    "AstrBotSttProvider",
    "AstrBotTtsProvider",
    "AstrBotAvatarOutputPort",
    "ProviderBridgeError",
    "ProviderBridgeCallbacks",
]
