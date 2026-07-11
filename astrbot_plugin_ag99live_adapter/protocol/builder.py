"""出站协议消息构造器。

按消息类别聚合"后端 → 前端"方向的信封构造函数，每个函数都是一次纯组装：
没有副作用，不查状态，只把入参塞进 build_message_envelope 出来一份 dict。

类别（按 protocol/constants.py 里的 TYPE_* 常量分组）：
    system.*  — 服务器信息、群组、模型同步、历史、心跳、语义轴档案、动作样本
    output.*  — 一次回复内的文本/音频/图片/转写片段（携带 turn_id + message_id）
    control.* — 轮次开始/结束、合成完成、中断、错误等控制信号

边界：
    - 不发送，只构造；真正的 send 由调用方完成。
    - 不校验 payload 形状（出站方向由调用方保证）。
    - 所有函数都把 source 写成 SOURCE_ADAPTER；其他 source（如 SOURCE_ENGINE）
      由调用方直接走 parser.build_message_envelope。
"""

from __future__ import annotations

from typing import Any

from .constants import (
    SOURCE_ADAPTER,
    SOURCE_ENGINE,
    TYPE_CONTROL_ERROR,
    TYPE_CONTROL_INTERRUPT,
    TYPE_CONTROL_START_MIC,
    TYPE_CONTROL_SYNTH_FINISHED,
    TYPE_CONTROL_TURN_FINISHED,
    TYPE_CONTROL_TURN_STARTED,
    TYPE_ENGINE_CATALOG_MOTION,
    TYPE_ENGINE_MOTION_PREVIEW,
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
    TYPE_SYSTEM_MOTION_TUNING_SAMPLES_STATE,
    TYPE_SYSTEM_MOTION_LAB_RAW_EVENT_RECORDED,
    TYPE_SYSTEM_SEMANTIC_AXIS_PROFILE_SAVED,
    TYPE_SYSTEM_SEMANTIC_AXIS_PROFILE_SAVE_FAILED,
    TYPE_SYSTEM_SERVER_INFO,
)
from .parser import build_message_envelope


def build_system_motion_lab_raw_event_recorded(
    *,
    event_id: str,
    turn_id: str | None,
) -> dict[str, Any]:
    return build_message_envelope(
        TYPE_SYSTEM_MOTION_LAB_RAW_EVENT_RECORDED,
        source=SOURCE_ADAPTER,
        turn_id=turn_id,
        payload={"event_id": event_id},
    )


def build_system_model_sync(
    *,
    model_info: dict[str, Any],
    runtime_cache_errors: dict[str, str] | None = None,
    conf_name: str,
    conf_uid: str,
    client_uid: str,
    ) -> dict[str, Any]:
    return build_message_envelope(
        TYPE_SYSTEM_MODEL_SYNC,
        source=SOURCE_ADAPTER,
        payload={
            "model_info": model_info,
            "runtime_cache_errors": {
                str(key).strip(): str(value).strip()
                for key, value in (runtime_cache_errors or {}).items()
                if str(key).strip() and str(value).strip()
            },
            "conf_name": conf_name,
            "conf_uid": conf_uid,
            "client_uid": client_uid,
        },
    )


def build_system_server_info(
    *,
    ws_url: str,
    http_base_url: str,
    auto_start_mic: bool,
) -> dict[str, Any]:
    return build_message_envelope(
        TYPE_SYSTEM_SERVER_INFO,
        source=SOURCE_ADAPTER,
        payload={
            "ws_url": ws_url,
            "http_base_url": http_base_url,
            "auto_start_mic": auto_start_mic,
        },
    )


def build_engine_motion_preview(
    *,
    motion_payload: dict[str, Any],
    motion_type: str,
    mode: str,
    source: str,
) -> dict[str, Any]:
    payload_key = "motion" if motion_type == TYPE_ENGINE_CATALOG_MOTION else "intent"
    return build_message_envelope(
        TYPE_ENGINE_MOTION_PREVIEW,
        source=SOURCE_ENGINE,
        turn_id=None,
        payload={
            "mode": str(mode or "preview"),
            "source": str(source or "analysis.notebook"),
            "motion_type": str(motion_type or ""),
            payload_key: motion_payload,
        },
    )


def build_system_group_update(
    *,
    members: list[dict[str, Any]] | list[Any],
    is_owner: bool,
) -> dict[str, Any]:
    return build_message_envelope(
        TYPE_SYSTEM_GROUP_UPDATE,
        source=SOURCE_ADAPTER,
        payload={"members": members, "is_owner": is_owner},
    )


def build_system_background_list(
    *,
    files: list[str],
) -> dict[str, Any]:
    return build_message_envelope(
        TYPE_SYSTEM_BACKGROUND_LIST,
        source=SOURCE_ADAPTER,
        payload={"files": files},
    )


def build_system_history_list(
    *,
    histories: list[dict[str, Any]],
) -> dict[str, Any]:
    return build_message_envelope(
        TYPE_SYSTEM_HISTORY_LIST,
        source=SOURCE_ADAPTER,
        payload={"histories": histories},
    )


def build_system_history_created(
    *,
    history_uid: str,
) -> dict[str, Any]:
    return build_message_envelope(
        TYPE_SYSTEM_HISTORY_CREATED,
        source=SOURCE_ADAPTER,
        payload={"history_uid": history_uid},
    )


def build_system_history_data(
    *,
    messages: list[dict[str, Any]],
) -> dict[str, Any]:
    return build_message_envelope(
        TYPE_SYSTEM_HISTORY_DATA,
        source=SOURCE_ADAPTER,
        payload={"messages": messages},
    )


def build_system_history_deleted(
    *,
    history_uid: str,
    success: bool,
) -> dict[str, Any]:
    return build_message_envelope(
        TYPE_SYSTEM_HISTORY_DELETED,
        source=SOURCE_ADAPTER,
        payload={"history_uid": history_uid, "success": success},
    )


def build_system_heartbeat_ack(
) -> dict[str, Any]:
    return build_message_envelope(
        TYPE_SYSTEM_HEARTBEAT_ACK,
        source=SOURCE_ADAPTER,
        payload={},
    )


def build_system_semantic_axis_profile_saved(
    *,
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
        turn_id=turn_id,
        source=SOURCE_ADAPTER,
        payload=payload,
    )


def build_system_motion_tuning_samples_state(
    *,
    samples: list[dict[str, Any]],
    root_error: str = "",
    load_error: str = "",
    diagnostics: list[str] | None = None,
    effective_examples: list[dict[str, Any]] | None = None,
    turn_id: str | None = None,
) -> dict[str, Any]:
    return build_message_envelope(
        TYPE_SYSTEM_MOTION_TUNING_SAMPLES_STATE,
        turn_id=turn_id,
        source=SOURCE_ADAPTER,
        payload={
            "root_error": str(root_error or "").strip(),
            "samples": samples,
            "load_error": str(load_error or "").strip(),
            "diagnostics": [
                str(item).strip()
                for item in (diagnostics or [])
                if str(item).strip()
            ],
            "effective_examples": [
                item
                for item in (effective_examples or [])
                if isinstance(item, dict)
            ],
        },
    )


def build_output_text(
    *,
    turn_id: str | None,
    message_id: str | None = None,
    text: str,
    speaker_name: str,
    avatar: str,
    audio_expected: bool = False,
) -> dict[str, Any]:
    return build_message_envelope(
        TYPE_OUTPUT_TEXT,
        turn_id=turn_id,
        message_id=message_id,
        source=SOURCE_ADAPTER,
        payload={
            "text": text,
            "speaker_name": speaker_name,
            "avatar": avatar,
            "audio_expected": bool(audio_expected),
        },
    )


def build_output_audio(
    *,
    turn_id: str | None,
    message_id: str | None = None,
    audio_url: str | None,
    caption_text: str,
    speaker_name: str,
    avatar: str,
) -> dict[str, Any]:
    return build_message_envelope(
        TYPE_OUTPUT_AUDIO,
        turn_id=turn_id,
        message_id=message_id,
        source=SOURCE_ADAPTER,
        payload={
            "audio_url": audio_url,
            "caption_text": caption_text,
            "speaker_name": speaker_name,
            "avatar": avatar,
        },
    )


def build_output_image(
    *,
    turn_id: str | None,
    images: list[str],
) -> dict[str, Any]:
    return build_message_envelope(
        TYPE_OUTPUT_IMAGE,
        turn_id=turn_id,
        source=SOURCE_ADAPTER,
        payload={"images": images},
    )


def build_output_transcription(
    *,
    turn_id: str | None,
    text: str,
) -> dict[str, Any]:
    return build_message_envelope(
        TYPE_OUTPUT_TRANSCRIPTION,
        turn_id=turn_id,
        source=SOURCE_ADAPTER,
        payload={"text": text},
    )


def build_control_turn_started(
    *,
    turn_id: str,
) -> dict[str, Any]:
    return build_message_envelope(
        TYPE_CONTROL_TURN_STARTED,
        turn_id=turn_id,
        source=SOURCE_ADAPTER,
        payload={},
    )


def build_control_turn_finished(
    *,
    turn_id: str | None,
    success: bool = True,
    reason: str | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {"success": success}
    if reason:
        payload["reason"] = reason
    return build_message_envelope(
        TYPE_CONTROL_TURN_FINISHED,
        turn_id=turn_id,
        source=SOURCE_ADAPTER,
        payload=payload,
    )


def build_control_start_mic() -> dict[str, Any]:
    return build_message_envelope(
        TYPE_CONTROL_START_MIC,
        source=SOURCE_ADAPTER,
        payload={},
    )


def build_control_interrupt(
    *,
    turn_id: str | None,
) -> dict[str, Any]:
    return build_message_envelope(
        TYPE_CONTROL_INTERRUPT,
        turn_id=turn_id,
        source=SOURCE_ADAPTER,
        payload={},
    )


def build_control_synth_finished(
    *,
    turn_id: str | None,
) -> dict[str, Any]:
    return build_message_envelope(
        TYPE_CONTROL_SYNTH_FINISHED,
        turn_id=turn_id,
        source=SOURCE_ADAPTER,
        payload={},
    )


def build_control_error(
    *,
    message: str,
    turn_id: str | None = None,
) -> dict[str, Any]:
    return build_message_envelope(
        TYPE_CONTROL_ERROR,
        turn_id=turn_id,
        source=SOURCE_ADAPTER,
        payload={"message": message},
    )
