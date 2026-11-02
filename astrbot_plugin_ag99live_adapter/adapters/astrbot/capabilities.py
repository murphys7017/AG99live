"""AstrBot capability callbacks used by the neutral Provider bridge."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

from astrbot.api import logger

from ...providers.contracts import (
    AudioArtifact,
    MotionRequest,
    ProviderFailure,
    SttResult,
    SttSessionOptions,
    TtsRequest,
)
from .provider_bridge import ProviderBridgeError


RecognizeAudio = Callable[[str, bytes, SttSessionOptions], Awaitable[SttResult | str]]


class AstrBotCapabilityBinding:
    """Bind existing AstrBot providers without exposing them to the runtime core."""

    def __init__(
        self,
        *,
        plugin_context: Any,
        recognize_audio: RecognizeAudio,
    ) -> None:
        self._plugin_context = plugin_context
        self._recognize_audio = recognize_audio

    async def recognize_audio(
        self,
        stream_id: str,
        pcm_bytes: bytes,
        options: SttSessionOptions,
    ) -> SttResult | str:
        return await self._recognize_audio(stream_id, pcm_bytes, options)

    async def synthesize_tts(self, request: TtsRequest) -> AudioArtifact:
        event = request.metadata.get("event")
        umo = str(getattr(event, "unified_msg_origin", "") or "").strip()
        get_provider = getattr(self._plugin_context, "get_using_tts_provider", None)
        if not callable(get_provider):
            raise ProviderBridgeError(
                ProviderFailure(
                    provider="astrbot.tts",
                    request_id=request.request_id,
                    code="tts_provider_registry_unavailable",
                    message="AstrBot TTS provider registry is unavailable.",
                    turn_id=request.turn_id,
                    message_id=request.message_id,
                )
            )
        provider = get_provider(umo=umo or None)
        if provider is None:
            raise ProviderBridgeError(
                ProviderFailure(
                    provider="astrbot.tts",
                    request_id=request.request_id,
                    code="tts_provider_unavailable",
                    message="No AstrBot TTS provider is configured for this session.",
                    turn_id=request.turn_id,
                    message_id=request.message_id,
                )
            )
        audio_path = await provider.get_audio(request.text)
        normalized_path = str(audio_path or "").strip()
        if not normalized_path:
            raise ProviderBridgeError(
                ProviderFailure(
                    provider="astrbot.tts",
                    request_id=request.request_id,
                    code="tts_audio_path_missing",
                    message="AstrBot TTS returned an empty audio path.",
                    turn_id=request.turn_id,
                    message_id=request.message_id,
                )
            )
        suffix = Path(normalized_path).suffix.lower().lstrip(".")
        return AudioArtifact(
            artifact_id=request.request_id,
            uri=normalized_path,
            format=f"audio/{suffix}" if suffix else "audio/wav",
        )

    async def cancel_tts(self, request_id: str) -> None:
        logger.debug("WIRING tts_provider_cancel request_id=%s", request_id)

    async def generate_motion(self, request: MotionRequest):
        from ...middleware.interaction_motion.independent import (
            generate_independent_motion,
        )
        from ...middleware.interaction_motion.shared import (
            _resolve_motion_runtime_bundle,
        )

        event = request.context.get("event")
        if event is None:
            raise ProviderBridgeError(
                ProviderFailure(
                    provider="astrbot.motion",
                    request_id=request.request_id,
                    code="motion_event_context_missing",
                    message="AstrBot Motion requires the owning event context.",
                    turn_id=request.turn_id,
                    message_id=request.message_id,
                )
            )
        bundle = _resolve_motion_runtime_bundle(event)
        provider = getattr(
            getattr(bundle, "runtime_state", None),
            "selected_independent_motion_provider",
            None,
        )
        if bundle is None or provider is None:
            raise ProviderBridgeError(
                ProviderFailure(
                    provider="astrbot.motion",
                    request_id=request.request_id,
                    code="motion_provider_unavailable",
                    message="No AstrBot independent Motion provider is configured.",
                    turn_id=request.turn_id,
                    message_id=request.message_id,
                )
            )
        result = await generate_independent_motion(
            event,
            bundle,
            provider=provider,
            assistant_text=request.text,
            prepared_context=request.context.get("prepared_context"),
            segment_intent=request.context.get("segment_intent"),
            persona_result_id=request.context.get("persona_result_id"),
            segment_index=request.context.get("segment_index"),
            segment_message_id=request.message_id,
            shadow=False,
            shadow_tasks=None,
        )
        if result.motion_payload is None:
            raise ProviderBridgeError(
                ProviderFailure(
                    provider="astrbot.motion",
                    request_id=request.request_id,
                    code=result.reason or "motion_payload_missing",
                    message="AstrBot Motion did not produce an accepted payload.",
                    turn_id=request.turn_id,
                    message_id=request.message_id,
                )
            )
        return result.motion_payload

    async def cancel_motion(self, request_id: str) -> None:
        logger.debug("WIRING motion_provider_cancel request_id=%s", request_id)


__all__ = ["AstrBotCapabilityBinding"]
