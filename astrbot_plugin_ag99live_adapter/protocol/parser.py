"""入站协议消息解析与通用信封构造。

本模块只做协议层校验：
    - 顶层信封字段（type / version / message_id / turn_id / source / timestamp）
    - 入站消息类型必须落在 INBOUND_ALLOWED_TYPES 内
    - 按 message_type 校验 payload 形状（_validate_payload）

只关心"消息形状是否合法"，不处理任何业务语义（轮次、播放、动作）。
业务级处理由 runtime/turn_coordinator.py 拿到 ProtocolMessage 之后完成。

出站方向只暴露 build_message_envelope 一个通用底座；
具体业务消息工厂在 protocol/builder.py 里围绕它包装。
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Mapping
from uuid import uuid4

from .constants import (
    INBOUND_ALLOWED_TYPES,
    KNOWN_MESSAGE_TYPES,
    PROTOCOL_VERSION,
    SOURCE_FRONTEND,
    TYPE_CONTROL_PLAYBACK_FINISHED,
    TYPE_INPUT_AUDIO_STREAM_CHUNK,
    TYPE_INPUT_TEXT,
    TYPE_SYSTEM_HISTORY_DELETE,
    TYPE_SYSTEM_HISTORY_LOAD,
    TYPE_SYSTEM_MOTION_LAB_RAW_EVENT,
    TYPE_SYSTEM_MOTION_TUNING_SAMPLE_DELETE,
    TYPE_SYSTEM_MOTION_TUNING_SAMPLE_SAVE,
    TYPE_SYSTEM_SEMANTIC_AXIS_PROFILE_SAVE,
)
from .models import (
    InboundMessage,
    ProtocolError,
    ProtocolMessage,
    TextInputPayload,
)


def parse_inbound_message(
    raw: Mapping[str, Any],
) -> ProtocolMessage:
    """解析一条入站信封并校验 payload。

    成功时返回 ProtocolMessage（封装信封字段 + 规范化后的 payload + 原始 raw）。
    任何字段缺失、类型错误、消息类型不在 INBOUND_ALLOWED_TYPES，统一抛 ProtocolError，
    由调用方（transport 层）捕获。timestamp 缺失时用当前 UTC 时间补齐；
    turn_id 允许为 None（_normalize_optional_string 把空串和非字符串都归一为 None）。
    """
    if not isinstance(raw, Mapping):
        raise ProtocolError("Protocol payload must be an object.")

    message_type = _require_message_type(raw.get("type"))
    if message_type not in KNOWN_MESSAGE_TYPES:
        raise ProtocolError(f"Unsupported message type: {message_type}")
    if message_type not in INBOUND_ALLOWED_TYPES:
        raise ProtocolError(f"Inbound message type is not allowed: {message_type}")

    payload_raw = raw.get("payload", {})
    if payload_raw is None:
        payload_raw = {}
    if not isinstance(payload_raw, Mapping):
        raise ProtocolError("`payload` must be an object.")

    payload = dict(payload_raw)
    turn_id = _normalize_optional_string(raw.get("turn_id"))
    source = _normalize_source(raw.get("source"), SOURCE_FRONTEND)
    version = _require_protocol_version(raw.get("version"))
    message_id = _require_message_id(raw.get("message_id"))
    timestamp = _normalize_optional_string(raw.get("timestamp")) or _utc_now_iso()

    _validate_payload(message_type, payload)

    normalized_raw = {
        "type": message_type,
        "version": version,
        "message_id": message_id,
        "timestamp": timestamp,
        "turn_id": turn_id,
        "source": source,
        "payload": payload,
    }
    return ProtocolMessage(
        type=message_type,
        version=version,
        message_id=message_id,
        timestamp=timestamp,
        turn_id=turn_id,
        source=source,
        payload=payload,
        raw=normalized_raw,
    )


def normalize_inbound_message(
    raw: Mapping[str, Any],
) -> InboundMessage:
    """把一条入站 input.text 信封规范化为 InboundMessage。

    比 parse_inbound_message 多两步：限定 type 必须是 input.text，
    且把 payload.text / payload.images 提取为 TextInputPayload。
    非 input.text 直接 ProtocolError 拒绝。
    """
    envelope = parse_inbound_message(raw)
    if envelope.type != TYPE_INPUT_TEXT:
        raise ProtocolError(f"Expected `{TYPE_INPUT_TEXT}`, got `{envelope.type}`")

    text = str(envelope.payload.get("text") or "").strip()
    images = envelope.payload.get("images", [])
    if not isinstance(images, list):
        raise ProtocolError("`payload.images` must be a list when provided.")
    return InboundMessage(
        envelope=envelope,
        payload=TextInputPayload(text=text, images=images),
    )


def build_message_envelope(
    message_type: str,
    *,
    source: str,
    payload: Mapping[str, Any] | None = None,
    turn_id: str | None = None,
    version: str = PROTOCOL_VERSION,
    message_id: str | None = None,
    timestamp: str | None = None,
) -> dict[str, Any]:
    """组装一份出站信封 dict。

    只做最薄的拼装，不校验 payload 形状（出站方向由调用方保证）。
    message_id 缺省时用 uuid4().hex 生成；timestamp 缺省时用当前 UTC 时间；
    其他字段必须由调用方显式给出。所有业务级 build_* 工厂函数都基于此组装，
    见 protocol/builder.py。
    """
    if message_type not in KNOWN_MESSAGE_TYPES:
        raise ProtocolError(f"Unsupported outbound message type: {message_type}")

    payload_dict = dict(payload or {})
    return {
        "type": message_type,
        "version": version,
        "message_id": message_id or uuid4().hex,
        "timestamp": timestamp or _utc_now_iso(),
        "turn_id": turn_id,
        "source": source,
        "payload": payload_dict,
    }


def _validate_payload(message_type: str, payload: dict[str, Any]) -> None:
    if message_type == TYPE_INPUT_TEXT:
        text = payload.get("text")
        if not isinstance(text, str) or not text.strip():
            raise ProtocolError("`input.text` requires `payload.text` to be a non-empty string.")
        images = payload.get("images", [])
        if images is None:
            payload["images"] = []
        elif not isinstance(images, list):
            raise ProtocolError("`input.text` requires `payload.images` to be a list when provided.")
        return

    if message_type == TYPE_CONTROL_PLAYBACK_FINISHED:
        success = payload.get("success", True)
        if not isinstance(success, bool):
            raise ProtocolError("`control.playback_finished` requires `payload.success` to be a boolean.")
        reason = payload.get("reason")
        if reason is not None and not isinstance(reason, str):
            raise ProtocolError("`control.playback_finished` requires `payload.reason` to be a string when provided.")
        return

    history_uid_types = {
        TYPE_SYSTEM_HISTORY_LOAD,
        TYPE_SYSTEM_HISTORY_DELETE,
    }
    if message_type in history_uid_types:
        history_uid = payload.get("history_uid")
        if not isinstance(history_uid, str) or not history_uid.strip():
            raise ProtocolError(f"`{message_type}` requires `payload.history_uid` to be a non-empty string.")
        return

    if message_type == TYPE_INPUT_AUDIO_STREAM_CHUNK:
        audio_base64 = payload.get("audio_base64")
        if not isinstance(audio_base64, str) or not audio_base64:
            raise ProtocolError("`input.audio_stream_chunk` requires `payload.audio_base64`.")
        return

    if message_type == TYPE_SYSTEM_SEMANTIC_AXIS_PROFILE_SAVE:
        request_id = payload.get("request_id")
        if not isinstance(request_id, str) or not request_id.strip():
            raise ProtocolError(
                "`system.semantic_axis_profile_save` requires `payload.request_id` to be a non-empty string."
            )
        model_name = payload.get("model_name")
        if not isinstance(model_name, str) or not model_name.strip():
            raise ProtocolError(
                "`system.semantic_axis_profile_save` requires `payload.model_name` to be a non-empty string."
            )
        profile_id = payload.get("profile_id")
        if not isinstance(profile_id, str) or not profile_id.strip():
            raise ProtocolError(
                "`system.semantic_axis_profile_save` requires `payload.profile_id` to be a non-empty string."
            )
        expected_revision = payload.get("expected_revision")
        if not isinstance(expected_revision, int) or expected_revision <= 0:
            raise ProtocolError(
                "`system.semantic_axis_profile_save` requires `payload.expected_revision` to be a positive integer."
            )
        profile = payload.get("profile")
        if not isinstance(profile, Mapping):
            raise ProtocolError(
                "`system.semantic_axis_profile_save` requires `payload.profile` to be an object."
            )
        return

    if message_type == TYPE_SYSTEM_MOTION_TUNING_SAMPLE_SAVE:
        sample = payload.get("sample")
        if not isinstance(sample, Mapping):
            raise ProtocolError(
                "`system.motion_tuning_sample_save` requires `payload.sample` to be an object."
            )
        sample_id = sample.get("id")
        if not isinstance(sample_id, str) or not sample_id.strip():
            raise ProtocolError(
                "`system.motion_tuning_sample_save` requires `payload.sample.id` to be a non-empty string."
            )
        profile_id = sample.get("profile_id")
        if not isinstance(profile_id, str) or not profile_id.strip():
            raise ProtocolError(
                "`system.motion_tuning_sample_save` requires `payload.sample.profile_id` to be a non-empty string."
            )
        profile_revision = sample.get("profile_revision")
        if not isinstance(profile_revision, int) or profile_revision <= 0:
            raise ProtocolError(
                "`system.motion_tuning_sample_save` requires `payload.sample.profile_revision` to be a positive integer."
            )
        adjusted_plan = sample.get("adjusted_plan")
        if not isinstance(adjusted_plan, Mapping):
            raise ProtocolError(
                "`system.motion_tuning_sample_save` requires `payload.sample.adjusted_plan` to be an object."
            )
        adjusted_axes = sample.get("adjusted_axes")
        if not isinstance(adjusted_axes, Mapping):
            raise ProtocolError(
                "`system.motion_tuning_sample_save` requires `payload.sample.adjusted_axes` to be an object."
            )
        return

    if message_type == TYPE_SYSTEM_MOTION_TUNING_SAMPLE_DELETE:
        sample_id = payload.get("sample_id")
        if not isinstance(sample_id, str) or not sample_id.strip():
            raise ProtocolError(
                "`system.motion_tuning_sample_delete` requires `payload.sample_id` to be a non-empty string."
            )
        return

    if message_type == TYPE_SYSTEM_MOTION_LAB_RAW_EVENT:
        event_id = payload.get("event_id")
        if not isinstance(event_id, str) or not event_id.strip():
            raise ProtocolError(
                "`system.motion_lab_raw_event` requires `payload.event_id` to be a non-empty string."
            )
        event_type = payload.get("event_type")
        if not isinstance(event_type, str) or not event_type.strip():
            raise ProtocolError(
                "`system.motion_lab_raw_event` requires `payload.event_type` to be a non-empty string."
            )
        raw = payload.get("raw")
        if not isinstance(raw, Mapping):
            raise ProtocolError(
                "`system.motion_lab_raw_event` requires `payload.raw` to be an object."
            )
        segment_message_id = payload.get("message_id")
        if segment_message_id is not None and (
            not isinstance(segment_message_id, str)
            or not segment_message_id.strip()
        ):
            raise ProtocolError(
                "`system.motion_lab_raw_event` payload.message_id must be a non-empty string when present."
            )
        return


def _require_message_type(value: Any) -> str:
    normalized = _normalize_optional_string(value)
    if not normalized:
        raise ProtocolError("`type` is required.")
    return normalized


def _require_protocol_version(value: Any) -> str:
    normalized = _normalize_optional_string(value)
    if normalized != PROTOCOL_VERSION:
        raise ProtocolError(
            f"`version` must be `{PROTOCOL_VERSION}`, got `{normalized or 'empty'}`."
        )
    return normalized


def _require_message_id(value: Any) -> str:
    normalized = _normalize_optional_string(value)
    if not normalized:
        raise ProtocolError("`message_id` is required.")
    return normalized


def _normalize_source(value: Any, default: str) -> str:
    normalized = _normalize_optional_string(value)
    return normalized or default


def _normalize_optional_string(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = value.strip()
    return normalized or None


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()
