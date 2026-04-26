"""Builders for outbound AG99live V2 protocol messages."""

from __future__ import annotations

from typing import Any

from .constants import (
    SOURCE_ADAPTER,
    TYPE_CONTROL_ERROR,
    TYPE_CONTROL_INTERRUPT,
    TYPE_CONTROL_START_MIC,
    TYPE_CONTROL_SYNTH_FINISHED,
    TYPE_CONTROL_TURN_FINISHED,
    TYPE_CONTROL_TURN_STARTED,
    TYPE_OUTPUT_AUDIO,
    TYPE_OUTPUT_IMAGE,
    TYPE_OUTPUT_TEXT,
    TYPE_OUTPUT_TRANSCRIPTION,
    TYPE_SYSTEM_BACKGROUND_LIST,
    TYPE_SYSTEM_GROUP_UPDATE,
    TYPE_SYSTEM_HEARTBEAT_ACK,
    TYPE_SYSTEM_HISTORY_CREATED,
    TYPE_SYSTEM_HISTORY_DATA,
    TYPE_SYSTEM_HISTORY_DELETED,
    TYPE_SYSTEM_HISTORY_LIST,
    TYPE_SYSTEM_MODEL_SYNC,
    TYPE_SYSTEM_SEMANTIC_AXIS_PROFILE_SAVED,
    TYPE_SYSTEM_SEMANTIC_AXIS_PROFILE_SAVE_FAILED,
    TYPE_SYSTEM_SERVER_INFO,
)
from .parser import build_message_envelope


def build_system_model_sync(
    *,
    session_id: str,
    model_info: dict[str, Any],
    conf_name: str,
    conf_uid: str,
    client_uid: str,
) -> dict[str, Any]:
    return build_message_envelope(
        TYPE_SYSTEM_MODEL_SYNC,
        session_id=session_id,
        source=SOURCE_ADAPTER,
        payload={
            "model_info": model_info,
            "conf_name": conf_name,
            "conf_uid": conf_uid,
            "client_uid": client_uid,
        },
    )


def build_system_server_info(
    *,
    session_id: str,
    ws_url: str,
    http_base_url: str,
    auto_start_mic: bool,
) -> dict[str, Any]:
    return build_message_envelope(
        TYPE_SYSTEM_SERVER_INFO,
        session_id=session_id,
        source=SOURCE_ADAPTER,
        payload={
            "ws_url": ws_url,
            "http_base_url": http_base_url,
            "auto_start_mic": auto_start_mic,
        },
    )


def build_system_group_update(
    *,
    session_id: str,
    members: list[dict[str, Any]] | list[Any],
    is_owner: bool,
) -> dict[str, Any]:
    return build_message_envelope(
        TYPE_SYSTEM_GROUP_UPDATE,
        session_id=session_id,
        source=SOURCE_ADAPTER,
        payload={"members": members, "is_owner": is_owner},
    )


def build_system_background_list(
    *,
    session_id: str,
    files: list[str],
) -> dict[str, Any]:
    return build_message_envelope(
        TYPE_SYSTEM_BACKGROUND_LIST,
        session_id=session_id,
        source=SOURCE_ADAPTER,
        payload={"files": files},
    )


def build_system_history_list(
    *,
    session_id: str,
    histories: list[dict[str, Any]],
) -> dict[str, Any]:
    return build_message_envelope(
        TYPE_SYSTEM_HISTORY_LIST,
        session_id=session_id,
        source=SOURCE_ADAPTER,
        payload={"histories": histories},
    )


def build_system_history_created(
    *,
    session_id: str,
    history_uid: str,
) -> dict[str, Any]:
    return build_message_envelope(
        TYPE_SYSTEM_HISTORY_CREATED,
        session_id=session_id,
        source=SOURCE_ADAPTER,
        payload={"history_uid": history_uid},
    )


def build_system_history_data(
    *,
    session_id: str,
    messages: list[dict[str, Any]],
) -> dict[str, Any]:
    return build_message_envelope(
        TYPE_SYSTEM_HISTORY_DATA,
        session_id=session_id,
        source=SOURCE_ADAPTER,
        payload={"messages": messages},
    )


def build_system_history_deleted(
    *,
    session_id: str,
    history_uid: str,
    success: bool,
) -> dict[str, Any]:
    return build_message_envelope(
        TYPE_SYSTEM_HISTORY_DELETED,
        session_id=session_id,
        source=SOURCE_ADAPTER,
        payload={"history_uid": history_uid, "success": success},
    )


def build_system_heartbeat_ack(
    *,
    session_id: str,
) -> dict[str, Any]:
    return build_message_envelope(
        TYPE_SYSTEM_HEARTBEAT_ACK,
        session_id=session_id,
        source=SOURCE_ADAPTER,
        payload={},
    )


def build_system_semantic_axis_profile_saved(
    *,
    session_id: str,
    request_id: str,
    model_name: str,
    profile_id: str,
    revision: int,
    source_hash: str,
    saved_at: str,
    turn_id: str | None = None,
) -> dict[str, Any]:
    return build_message_envelope(
        TYPE_SYSTEM_SEMANTIC_AXIS_PROFILE_SAVED,
        session_id=session_id,
        turn_id=turn_id,
        source=SOURCE_ADAPTER,
        payload={
            "request_id": request_id,
            "model_name": model_name,
            "profile_id": profile_id,
            "revision": revision,
            "source_hash": source_hash,
            "saved_at": saved_at,
        },
    )


def build_system_semantic_axis_profile_save_failed(
    *,
    session_id: str,
    request_id: str,
    model_name: str,
    profile_id: str,
    expected_revision: int | None = None,
    error_code: str,
    message: str,
    turn_id: str | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "request_id": request_id,
        "model_name": model_name,
        "profile_id": profile_id,
        "error_code": error_code,
        "message": message,
    }
    if expected_revision is not None:
        payload["expected_revision"] = expected_revision
    return build_message_envelope(
        TYPE_SYSTEM_SEMANTIC_AXIS_PROFILE_SAVE_FAILED,
        session_id=session_id,
        turn_id=turn_id,
        source=SOURCE_ADAPTER,
        payload=payload,
    )


def build_output_text(
    *,
    session_id: str,
    turn_id: str | None,
    text: str,
    speaker_name: str,
    avatar: str,
) -> dict[str, Any]:
    return build_message_envelope(
        TYPE_OUTPUT_TEXT,
        session_id=session_id,
        turn_id=turn_id,
        source=SOURCE_ADAPTER,
        payload={
            "text": text,
            "speaker_name": speaker_name,
            "avatar": avatar,
        },
    )


def build_output_audio(
    *,
    session_id: str,
    turn_id: str | None,
    audio_url: str | None,
    text: str,
    speaker_name: str,
    avatar: str,
) -> dict[str, Any]:
    return build_message_envelope(
        TYPE_OUTPUT_AUDIO,
        session_id=session_id,
        turn_id=turn_id,
        source=SOURCE_ADAPTER,
        payload={
            "audio_url": audio_url,
            "text": text,
            "speaker_name": speaker_name,
            "avatar": avatar,
        },
    )


def build_output_image(
    *,
    session_id: str,
    turn_id: str | None,
    images: list[str],
) -> dict[str, Any]:
    return build_message_envelope(
        TYPE_OUTPUT_IMAGE,
        session_id=session_id,
        turn_id=turn_id,
        source=SOURCE_ADAPTER,
        payload={"images": images},
    )


def build_output_transcription(
    *,
    session_id: str,
    turn_id: str | None,
    text: str,
) -> dict[str, Any]:
    return build_message_envelope(
        TYPE_OUTPUT_TRANSCRIPTION,
        session_id=session_id,
        turn_id=turn_id,
        source=SOURCE_ADAPTER,
        payload={"text": text},
    )


def build_control_turn_started(
    *,
    session_id: str,
    turn_id: str,
) -> dict[str, Any]:
    return build_message_envelope(
        TYPE_CONTROL_TURN_STARTED,
        session_id=session_id,
        turn_id=turn_id,
        source=SOURCE_ADAPTER,
        payload={},
    )


def build_control_turn_finished(
    *,
    session_id: str,
    turn_id: str | None,
    success: bool = True,
    reason: str | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {"success": success}
    if reason:
        payload["reason"] = reason
    return build_message_envelope(
        TYPE_CONTROL_TURN_FINISHED,
        session_id=session_id,
        turn_id=turn_id,
        source=SOURCE_ADAPTER,
        payload=payload,
    )


def build_control_start_mic(
    *,
    session_id: str,
) -> dict[str, Any]:
    return build_message_envelope(
        TYPE_CONTROL_START_MIC,
        session_id=session_id,
        source=SOURCE_ADAPTER,
        payload={},
    )


def build_control_interrupt(
    *,
    session_id: str,
    turn_id: str | None,
) -> dict[str, Any]:
    return build_message_envelope(
        TYPE_CONTROL_INTERRUPT,
        session_id=session_id,
        turn_id=turn_id,
        source=SOURCE_ADAPTER,
        payload={},
    )


def build_control_synth_finished(
    *,
    session_id: str,
    turn_id: str | None,
) -> dict[str, Any]:
    return build_message_envelope(
        TYPE_CONTROL_SYNTH_FINISHED,
        session_id=session_id,
        turn_id=turn_id,
        source=SOURCE_ADAPTER,
        payload={},
    )


def build_control_error(
    *,
    session_id: str,
    message: str,
    turn_id: str | None = None,
) -> dict[str, Any]:
    return build_message_envelope(
        TYPE_CONTROL_ERROR,
        session_id=session_id,
        turn_id=turn_id,
        source=SOURCE_ADAPTER,
        payload={"message": message},
    )
