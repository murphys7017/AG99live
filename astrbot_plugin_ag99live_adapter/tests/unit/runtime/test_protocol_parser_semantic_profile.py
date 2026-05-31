from __future__ import annotations

import pytest

from astrbot_plugin_ag99live_adapter.protocol.parser import parse_inbound_message
from astrbot_plugin_ag99live_adapter.protocol.models import ProtocolError


def _message(message_type: str, payload: dict) -> dict:
    return {
        "type": message_type,
        "version": "v2",
        "message_id": f"test-{message_type}",
        "turn_id": "turn-test",
        "source": "frontend",
        "payload": payload,
    }


def test_parse_inbound_message_accepts_semantic_axis_profile_save() -> None:
    envelope = parse_inbound_message(
        _message(
            "system.semantic_axis_profile_save",
            {
                "request_id": "request-1",
                "model_name": "DemoModel",
                "profile_id": "DemoModel.semantic.v1",
                "expected_revision": 3,
                "profile": {"schema_version": "ag99.semantic_axis_profile.v1"},
            },
        ),
    )

    assert envelope.type == "system.semantic_axis_profile_save"
    assert envelope.payload["request_id"] == "request-1"
    assert envelope.payload["model_name"] == "DemoModel"
    assert envelope.payload["expected_revision"] == 3


def test_parse_inbound_message_rejects_invalid_semantic_axis_profile_save_payload() -> None:
    with pytest.raises(ProtocolError):
        parse_inbound_message(
            _message(
                "system.semantic_axis_profile_save",
                {
                    "request_id": "request-1",
                    "model_name": "DemoModel",
                    "expected_revision": "3",
                    "profile": {"schema_version": "ag99.semantic_axis_profile.v1"},
                },
            ),
        )


def test_parse_inbound_message_accepts_motion_tuning_sample_save() -> None:
    envelope = parse_inbound_message(
        _message(
            "system.motion_tuning_sample_save",
            {
                "sample": {
                    "id": "sample-1",
                    "created_at": "2026-04-29T00:00:00+00:00",
                    "source_record_id": "record-1",
                    "model_name": "DemoModel",
                    "profile_id": "DemoModel.semantic.v1",
                    "profile_revision": 3,
                    "emotion_label": "joy",
                    "assistant_text": "好的",
                    "feedback": "嘴角再明显一点",
                    "tags": ["smile"],
                    "enabled_for_llm_reference": True,
                    "original_axes": {"mouth_smile": 0.6},
                    "adjusted_axes": {"mouth_smile": 0.8},
                    "adjusted_plan": {
                        "schema_version": "engine.parameter_plan.v2",
                        "profile_id": "DemoModel.semantic.v1",
                        "profile_revision": 3,
                        "model_id": "DemoModel",
                        "mode": "expressive",
                        "emotion_label": "joy",
                        "timing": {
                            "duration_ms": 1200,
                            "blend_in_ms": 120,
                            "hold_ms": 800,
                            "blend_out_ms": 280,
                        },
                        "parameters": [
                            {
                                "axis_id": "mouth_smile",
                                "parameter_id": "ParamMouthSmile",
                                "target_value": 0.8,
                                "weight": 1.0,
                                "input_value": 0.8,
                                "source": "manual",
                            }
                        ],
                    },
                },
            },
        ),
    )

    assert envelope.type == "system.motion_tuning_sample_save"
    assert envelope.payload["sample"]["profile_revision"] == 3


def test_parse_inbound_message_accepts_motion_tuning_sample_delete() -> None:
    envelope = parse_inbound_message(
        _message(
            "system.motion_tuning_sample_delete",
            {
                "sample_id": "sample-1",
            },
        ),
    )

    assert envelope.type == "system.motion_tuning_sample_delete"
    assert envelope.payload["sample_id"] == "sample-1"


def test_parse_inbound_message_accepts_raw_audio_data_payload() -> None:
    envelope = parse_inbound_message(
        _message(
            "input.raw_audio_data",
            {
                "audio": [0.1, -0.2, 0],
                "sample_rate": 16000,
                "channels": 1,
            },
        ),
    )

    assert envelope.type == "input.raw_audio_data"
    assert envelope.payload["audio"] == [0.1, -0.2, 0]


def test_parse_inbound_message_rejects_invalid_raw_audio_data_payload() -> None:
    with pytest.raises(ProtocolError, match="payload.audio"):
        parse_inbound_message(
            _message(
                "input.raw_audio_data",
                {
                    "audio": [0.1, "bad"],
                    "sample_rate": 16000,
                    "channels": 1,
                },
            ),
        )


def test_parse_inbound_message_rejects_engine_parameter_plan_preview() -> None:
    with pytest.raises(ProtocolError, match="Unsupported message type"):
        parse_inbound_message(
            _message(
                "engine.parameter_plan",
                {
                    "mode": "preview",
                    "plan": {
                        "schema_version": "engine.parameter_plan.v2",
                    },
                },
            ),
        )


def test_parse_inbound_message_rejects_removed_motion_tuning_examples_sync() -> None:
    with pytest.raises(ProtocolError, match="Unsupported message type"):
        parse_inbound_message(
            _message("system.motion_tuning_examples_sync", {"examples": []}),
        )
