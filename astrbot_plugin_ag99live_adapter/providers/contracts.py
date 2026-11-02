"""Host-neutral capability ports and DTOs.

This module is the first Phase 1 boundary. It describes ownership and data
shape without importing AstrBot, WebSocket, Electron, or a concrete provider
SDK. Providers return facts; the Interaction Orchestrator owns Turn/Segment
identity and is the only component allowed to assemble a final output segment.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Protocol, TypeAlias


ListenerResult: TypeAlias = Awaitable[None] | None
Unsubscribe: TypeAlias = Callable[[], None]


class ConversationEventKind(str, Enum):
    """Facts a ConversationProvider may report to the orchestrator."""

    TURN_STARTED = "turn_started"
    TEXT_DELTA = "text_delta"
    TEXT_COMPLETED = "text_completed"
    SEGMENT_BOUNDARY = "segment_boundary"
    TURN_COMPLETED = "turn_completed"
    TURN_FAILED = "turn_failed"
    INTERRUPTED = "interrupted"


class MotionOrigin(str, Enum):
    """Whether motion belongs to a conversational Turn or passive behavior."""

    TURN = "turn"
    PASSIVE = "passive"


class TtsEventKind(str, Enum):
    REQUESTED = "requested"
    GENERATING = "generating"
    READY = "ready"
    FAILED = "failed"
    CANCELLED = "cancelled"


class MotionEventKind(str, Enum):
    REQUESTED = "requested"
    READY = "ready"
    FAILED = "failed"
    CANCELLED = "cancelled"


def _require_id(value: str, field_name: str) -> str:
    normalized = str(value or "").strip()
    if not normalized:
        raise ValueError(f"{field_name}_required")
    return normalized


def _optional_id(value: str | None, field_name: str) -> str | None:
    if value is None:
        return None
    normalized = str(value).strip()
    if not normalized:
        raise ValueError(f"{field_name}_invalid")
    return normalized


@dataclass(frozen=True)
class ConversationInput:
    """A message admitted by the orchestrator into one conversation Turn."""

    turn_id: str
    text: str
    message_id: str | None = None
    metadata: Mapping[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        _require_id(self.turn_id, "turn_id")
        if not isinstance(self.text, str):
            raise TypeError("conversation_text_must_be_string")
        if self.message_id is not None:
            _optional_id(self.message_id, "message_id")


@dataclass(frozen=True)
class SegmentBoundary:
    """A provider-local hint that a new logical output segment may begin."""

    provider_boundary_id: str
    reason: str = "provider_boundary"

    def __post_init__(self) -> None:
        _require_id(self.provider_boundary_id, "provider_boundary_id")
        _require_id(self.reason, "boundary_reason")


@dataclass(frozen=True)
class ConversationEvent:
    """A conversation fact; never a final protocol output segment."""

    kind: ConversationEventKind
    turn_id: str
    provider_event_id: str
    text: str = ""
    boundary: SegmentBoundary | None = None
    reason: str | None = None
    metadata: Mapping[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not isinstance(self.kind, ConversationEventKind):
            raise TypeError("conversation_event_kind_invalid")
        _require_id(self.turn_id, "turn_id")
        _require_id(self.provider_event_id, "provider_event_id")
        if not isinstance(self.text, str):
            raise TypeError("conversation_event_text_must_be_string")
        if self.kind is ConversationEventKind.SEGMENT_BOUNDARY and self.boundary is None:
            raise ValueError("segment_boundary_required")
        if self.reason is not None and not str(self.reason).strip():
            raise ValueError("conversation_event_reason_invalid")


@dataclass(frozen=True)
class SttSessionOptions:
    """Provider-neutral options for one bounded audio input stream."""

    sample_rate: int = 16_000
    channels: int = 1
    encoding: str = "pcm_s16le"
    metadata: Mapping[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if (
            isinstance(self.sample_rate, bool)
            or not isinstance(self.sample_rate, int)
            or self.sample_rate <= 0
        ):
            raise ValueError("stt_sample_rate_invalid")
        if (
            isinstance(self.channels, bool)
            or not isinstance(self.channels, int)
            or self.channels <= 0
        ):
            raise ValueError("stt_channels_invalid")
        _require_id(self.encoding, "stt_encoding")


@dataclass(frozen=True)
class SttResult:
    stream_id: str
    text: str
    confidence: float | None = None
    metadata: Mapping[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        _require_id(self.stream_id, "stream_id")
        if not isinstance(self.text, str):
            raise TypeError("stt_text_must_be_string")


@dataclass(frozen=True)
class TtsRequest:
    request_id: str
    turn_id: str
    message_id: str
    text: str
    metadata: Mapping[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        _require_id(self.request_id, "tts_request_id")
        _require_id(self.turn_id, "turn_id")
        _require_id(self.message_id, "message_id")
        if not isinstance(self.text, str):
            raise TypeError("tts_text_must_be_string")


@dataclass(frozen=True)
class AudioArtifact:
    """The single audio resource shape visible outside the media owner."""

    artifact_id: str
    uri: str
    format: str
    duration_ms: int | None = None
    sample_rate: int | None = None

    def __post_init__(self) -> None:
        _require_id(self.artifact_id, "audio_artifact_id")
        _require_id(self.uri, "audio_artifact_uri")
        _require_id(self.format, "audio_artifact_format")
        if self.duration_ms is not None and (
            isinstance(self.duration_ms, bool)
            or not isinstance(self.duration_ms, int)
            or self.duration_ms < 0
        ):
            raise ValueError("audio_artifact_duration_invalid")
        if self.sample_rate is not None and (
            isinstance(self.sample_rate, bool)
            or not isinstance(self.sample_rate, int)
            or self.sample_rate <= 0
        ):
            raise ValueError("audio_artifact_sample_rate_invalid")


@dataclass(frozen=True)
class TtsResult:
    request_id: str
    artifact: AudioArtifact | None = None
    phoneme_cues: tuple[Mapping[str, Any], ...] = ()
    metadata: Mapping[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        _require_id(self.request_id, "tts_request_id")


@dataclass(frozen=True)
class TtsLifecycleEvent:
    request_id: str
    kind: TtsEventKind
    turn_id: str | None = None
    message_id: str | None = None
    artifact: AudioArtifact | None = None
    reason: str | None = None
    metadata: Mapping[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        _require_id(self.request_id, "tts_request_id")
        if not isinstance(self.kind, TtsEventKind):
            raise TypeError("tts_event_kind_invalid")
        _optional_id(self.turn_id, "turn_id")
        _optional_id(self.message_id, "message_id")
        if self.reason is not None and not str(self.reason).strip():
            raise ValueError("tts_event_reason_invalid")


@dataclass(frozen=True)
class ProviderFailure:
    """Structured failure fact that can be attached to a Turn or request."""

    provider: str
    request_id: str
    code: str
    message: str
    turn_id: str | None = None
    message_id: str | None = None
    retryable: bool = False

    def __post_init__(self) -> None:
        _require_id(self.provider, "provider_name")
        _require_id(self.request_id, "provider_request_id")
        _require_id(self.code, "provider_failure_code")
        _require_id(self.message, "provider_failure_message")
        _optional_id(self.turn_id, "turn_id")
        _optional_id(self.message_id, "message_id")
        if not isinstance(self.retryable, bool):
            raise TypeError("provider_failure_retryable_invalid")


@dataclass(frozen=True)
class ProviderCancellation:
    """Structured cancellation fact; cancellation is not a successful result."""

    provider: str
    request_id: str
    reason: str
    turn_id: str | None = None
    message_id: str | None = None

    def __post_init__(self) -> None:
        _require_id(self.provider, "provider_name")
        _require_id(self.request_id, "provider_request_id")
        _require_id(self.reason, "provider_cancellation_reason")
        _optional_id(self.turn_id, "turn_id")
        _optional_id(self.message_id, "message_id")


@dataclass(frozen=True)
class MotionRequest:
    request_id: str
    origin: MotionOrigin
    text: str = ""
    turn_id: str | None = None
    message_id: str | None = None
    context: Mapping[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        _require_id(self.request_id, "motion_request_id")
        if not isinstance(self.origin, MotionOrigin):
            raise TypeError("motion_origin_invalid")
        if not isinstance(self.text, str):
            raise TypeError("motion_text_must_be_string")
        normalized_turn_id = _optional_id(self.turn_id, "turn_id")
        normalized_message_id = _optional_id(self.message_id, "message_id")
        if self.origin is MotionOrigin.TURN and (
            normalized_turn_id is None or normalized_message_id is None
        ):
            raise ValueError("turn_motion_identity_required")


@dataclass(frozen=True)
class MotionResult:
    request_id: str
    origin: MotionOrigin
    payload: Mapping[str, Any]
    metadata: Mapping[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        _require_id(self.request_id, "motion_request_id")
        if not isinstance(self.origin, MotionOrigin):
            raise TypeError("motion_origin_invalid")
        if not isinstance(self.payload, Mapping):
            raise TypeError("motion_payload_must_be_mapping")


@dataclass(frozen=True)
class MotionLifecycleEvent:
    request_id: str
    kind: MotionEventKind
    origin: MotionOrigin
    turn_id: str | None = None
    message_id: str | None = None
    payload: Mapping[str, Any] | None = None
    reason: str | None = None
    metadata: Mapping[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        _require_id(self.request_id, "motion_request_id")
        if not isinstance(self.kind, MotionEventKind):
            raise TypeError("motion_event_kind_invalid")
        if not isinstance(self.origin, MotionOrigin):
            raise TypeError("motion_origin_invalid")
        _optional_id(self.turn_id, "turn_id")
        _optional_id(self.message_id, "message_id")
        if self.payload is not None and not isinstance(self.payload, Mapping):
            raise TypeError("motion_event_payload_must_be_mapping")
        if self.reason is not None and not str(self.reason).strip():
            raise ValueError("motion_event_reason_invalid")


@dataclass(frozen=True)
class OutputSegmentEnvelope:
    """A final segment created by the Orchestrator for an output port."""

    turn_id: str
    message_id: str
    sequence: int
    payload: Mapping[str, Any]

    def __post_init__(self) -> None:
        _require_id(self.turn_id, "turn_id")
        _require_id(self.message_id, "message_id")
        if (
            isinstance(self.sequence, bool)
            or not isinstance(self.sequence, int)
            or self.sequence < 0
        ):
            raise ValueError("output_segment_sequence_invalid")
        if not isinstance(self.payload, Mapping):
            raise TypeError("output_segment_payload_must_be_mapping")


@dataclass(frozen=True)
class ControlEvent:
    type: str
    turn_id: str | None = None
    payload: Mapping[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        _require_id(self.type, "control_event_type")
        _optional_id(self.turn_id, "turn_id")


@dataclass(frozen=True)
class ProtocolError:
    code: str
    message: str
    turn_id: str | None = None
    metadata: Mapping[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        _require_id(self.code, "protocol_error_code")
        _require_id(self.message, "protocol_error_message")
        _optional_id(self.turn_id, "turn_id")


ConversationListener: TypeAlias = Callable[[ConversationEvent], ListenerResult]
PartialTranscriptListener: TypeAlias = Callable[[str, str], ListenerResult]
FinalTranscriptListener: TypeAlias = Callable[[SttResult], ListenerResult]
TtsEventListener: TypeAlias = Callable[[TtsLifecycleEvent], ListenerResult]
MotionEventListener: TypeAlias = Callable[[MotionLifecycleEvent], ListenerResult]


class ConversationProvider(Protocol):
    """Conversation facts only; no final Segment or protocol publication."""

    async def send_message(self, request: ConversationInput) -> None: ...

    async def interrupt(self, turn_id: str | None = None) -> None: ...

    async def close(self) -> None: ...

    def subscribe(self, listener: ConversationListener) -> Unsubscribe: ...


class SttProvider(Protocol):
    """One provider may own many independently identified audio streams."""

    async def start_session(
        self,
        stream_id: str,
        options: SttSessionOptions | None = None,
    ) -> None: ...

    async def push_audio(self, stream_id: str, chunk: bytes) -> None: ...

    async def finish_session(self, stream_id: str) -> SttResult: ...

    async def cancel_session(self, stream_id: str) -> None: ...

    def on_partial(self, listener: PartialTranscriptListener) -> Unsubscribe: ...

    def on_final(self, listener: FinalTranscriptListener) -> Unsubscribe: ...


class TtsProvider(Protocol):
    async def synthesize(self, request: TtsRequest) -> TtsResult: ...

    async def cancel(self, request_id: str) -> None: ...

    def subscribe(self, listener: TtsEventListener) -> Unsubscribe: ...


class MotionProvider(Protocol):
    async def generate(self, request: MotionRequest) -> MotionResult: ...

    async def cancel(self, request_id: str) -> None: ...

    def subscribe(self, listener: MotionEventListener) -> Unsubscribe: ...


class AvatarOutputPort(Protocol):
    """The only port allowed to publish final Avatar protocol facts."""

    async def publish_segment(self, segment: OutputSegmentEnvelope) -> None: ...

    async def publish_control(self, event: ControlEvent) -> None: ...

    async def publish_error(self, error: ProtocolError) -> None: ...


class ProviderRegistry(Protocol):
    """Host-owned registry used by RuntimeState without importing a host SDK."""

    def get_chat_provider(self, provider_id: str) -> Any | None: ...

    def get_stt_provider(self, *, platform_id: str, client_uid: str) -> Any | None: ...


__all__ = [
    "AudioArtifact",
    "AvatarOutputPort",
    "ConversationEvent",
    "ConversationEventKind",
    "ConversationInput",
    "ConversationProvider",
    "ControlEvent",
    "FinalTranscriptListener",
    "MotionEventKind",
    "MotionEventListener",
    "MotionLifecycleEvent",
    "MotionOrigin",
    "MotionProvider",
    "MotionRequest",
    "MotionResult",
    "OutputSegmentEnvelope",
    "PartialTranscriptListener",
    "ProtocolError",
    "ProviderRegistry",
    "ProviderCancellation",
    "ProviderFailure",
    "SegmentBoundary",
    "SttProvider",
    "SttResult",
    "SttSessionOptions",
    "TtsProvider",
    "TtsEventKind",
    "TtsEventListener",
    "TtsLifecycleEvent",
    "TtsRequest",
    "TtsResult",
    "Unsubscribe",
]
