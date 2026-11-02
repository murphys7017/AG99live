"""AstrBot lifecycle facts projected into neutral Provider events."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from astrbot.api import logger

from ...providers.contracts import (
    AudioArtifact,
    MotionEventKind,
    MotionLifecycleEvent,
    MotionOrigin,
    TtsEventKind,
    TtsLifecycleEvent,
)


class AstrBotLifecycleBridge:
    """Keep AstrBot hook state conversion outside the plugin entry class."""

    @staticmethod
    async def publish_tts_state(event: Any, state: Any) -> None:
        publish_event = _provider_publisher(event, "tts")
        if publish_event is None:
            return
        request_id = str(
            getattr(state, "tts_request_id", None)
            or getattr(state, "request_id", None)
            or ""
        ).strip()
        if not request_id:
            return
        status = str(getattr(state, "status", "") or "").strip().lower()
        kind = {
            "requested": TtsEventKind.REQUESTED,
            "generating": TtsEventKind.GENERATING,
            "succeeded": TtsEventKind.READY,
            "failed": TtsEventKind.FAILED,
            "error": TtsEventKind.FAILED,
            "cancelled": TtsEventKind.CANCELLED,
            "canceled": TtsEventKind.CANCELLED,
        }.get(status)
        if kind is None:
            return

        artifact = None
        artifact_error = None
        if kind is TtsEventKind.READY:
            uri = str(
                getattr(state, "audio_url", None)
                or getattr(state, "audio_uri", None)
                or getattr(state, "audio_path", None)
                or ""
            ).strip()
            if uri:
                audio_format = str(
                    getattr(state, "format", None)
                    or getattr(state, "audio_format", None)
                    or ""
                ).strip()
                if not audio_format and "." in uri.rsplit("/", 1)[-1]:
                    audio_format = uri.rsplit(".", 1)[-1]
                duration_ms = getattr(state, "duration_ms", None)
                if isinstance(duration_ms, bool) or not isinstance(duration_ms, int):
                    duration_ms = None
                sample_rate = getattr(state, "sample_rate", None)
                if isinstance(sample_rate, bool) or not isinstance(sample_rate, int):
                    sample_rate = None
                try:
                    artifact = AudioArtifact(
                        artifact_id=request_id,
                        uri=uri,
                        format=audio_format or "audio/wav",
                        duration_ms=duration_ms,
                        sample_rate=sample_rate,
                    )
                except (TypeError, ValueError) as exc:
                    artifact_error = str(exc) or "tts_artifact_invalid"

        lifecycle_event = TtsLifecycleEvent(
            request_id=request_id,
            kind=kind,
            turn_id=str(getattr(state, "turn_id", "") or "").strip() or None,
            message_id=str(getattr(state, "message_id", "") or "").strip() or None,
            artifact=artifact,
            reason=(
                str(
                    getattr(state, "failure_reason", None)
                    or getattr(state, "reason", None)
                    or ""
                ).strip()
                or None
            ),
            metadata={
                "stage": str(getattr(state, "stage", "") or ""),
                "status": status,
                "persona_result_id": str(getattr(state, "persona_result_id", "") or ""),
                "persona_segment_index": getattr(state, "persona_segment_index", None),
                "artifact_error": artifact_error,
            },
        )
        try:
            await publish_event(lifecycle_event)
        except Exception:  # noqa: BLE001 - observation cannot stop host TTS.
            logger.debug(
                "WIRING tts_provider_event_publish_failed request_id=%s",
                request_id,
                exc_info=True,
            )

    @staticmethod
    async def publish_motion_state(
        event: Any,
        *,
        request_id: str,
        turn_id: str | None,
        message_id: str | None,
        payload: Mapping[str, Any] | None,
        reason: str | None,
        origin: str = "turn",
    ) -> None:
        publish_event = _provider_publisher(event, "motion")
        if publish_event is None:
            return
        normalized_request_id = str(request_id or "").strip()
        if not normalized_request_id:
            return
        normalized_origin = (
            MotionOrigin.PASSIVE
            if str(origin or "").strip() == MotionOrigin.PASSIVE.value
            else MotionOrigin.TURN
        )
        lifecycle_event = MotionLifecycleEvent(
            request_id=normalized_request_id,
            kind=(
                MotionEventKind.READY
                if isinstance(payload, Mapping)
                else MotionEventKind.FAILED
            ),
            origin=normalized_origin,
            turn_id=str(turn_id or "").strip() or None,
            message_id=str(message_id or "").strip() or None,
            payload=dict(payload) if isinstance(payload, Mapping) else None,
            reason=str(reason or "").strip() or None,
        )
        try:
            await publish_event(lifecycle_event)
        except Exception:  # noqa: BLE001 - observation cannot stop motion.
            logger.debug(
                "WIRING motion_provider_event_publish_failed request_id=%s",
                normalized_request_id,
                exc_info=True,
            )


def _provider_publisher(event: Any, capability: str):
    adapter = getattr(event, "adapter", None)
    bridge = getattr(adapter, "provider_bridge", None)
    provider = getattr(bridge, capability, None)
    publisher = getattr(provider, "publish_event", None)
    return publisher if callable(publisher) else None


__all__ = ["AstrBotLifecycleBridge"]
