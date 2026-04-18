"""Builders for outbound OLV desktop-pet payloads."""

from __future__ import annotations

from typing import Any


def build_set_model_and_conf(
    model_info: dict[str, Any],
    conf_name: str,
    conf_uid: str,
    client_uid: str,
) -> dict[str, Any]:
    return {
        "type": "set-model-and-conf",
        "model_info": model_info,
        "conf_name": conf_name,
        "conf_uid": conf_uid,
        "client_uid": client_uid,
    }


def build_control(text: str) -> dict[str, Any]:
    return {"type": "control", "text": text}


def build_full_text(text: str) -> dict[str, Any]:
    return {"type": "full-text", "text": text}


def build_backend_synth_complete() -> dict[str, Any]:
    return {"type": "backend-synth-complete"}


def build_force_new_message() -> dict[str, Any]:
    return {"type": "force-new-message"}


def build_error(message: str) -> dict[str, Any]:
    return {"type": "error", "message": message}


def build_audio_payload(
    audio_path: str,
    audio_url: str | None,
    text: str,
    speaker_name: str,
    avatar: str,
    action_mapping: dict[str, Any] | None = None,
) -> dict[str, Any]:
    display_text = {"text": text, "name": speaker_name, "avatar": avatar}
    del audio_path
    return _prepare_audio_payload(
        audio_url=audio_url,
        display_text=display_text,
        actions=action_mapping,
        forwarded=False,
    )


def _prepare_audio_payload(
    audio_url: str | None,
    display_text: dict[str, Any] | None = None,
    actions: dict[str, Any] | None = None,
    forwarded: bool = False,
) -> dict[str, Any]:
    """Local OLV-compatible audio payload builder to avoid external import coupling."""
    return {
        "type": "audio",
        "audio_url": audio_url,
        "display_text": display_text,
        "actions": actions,
        "forwarded": forwarded,
    }
