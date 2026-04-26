from __future__ import annotations

import pytest

from astrbot_plugin_ag99live_adapter.protocol.parser import parse_inbound_message
from astrbot_plugin_ag99live_adapter.protocol.models import ProtocolError


def test_parse_inbound_message_accepts_semantic_axis_profile_save() -> None:
    envelope = parse_inbound_message(
        {
            "type": "system.semantic_axis_profile_save",
            "session_id": "session",
            "source": "frontend",
            "payload": {
                "request_id": "request-1",
                "model_name": "DemoModel",
                "profile_id": "DemoModel.semantic.v1",
                "expected_revision": 3,
                "profile": {"schema_version": "ag99.semantic_axis_profile.v1"},
            },
        },
        default_session_id="fallback-session",
    )

    assert envelope.type == "system.semantic_axis_profile_save"
    assert envelope.payload["request_id"] == "request-1"
    assert envelope.payload["model_name"] == "DemoModel"
    assert envelope.payload["expected_revision"] == 3


def test_parse_inbound_message_rejects_invalid_semantic_axis_profile_save_payload() -> None:
    with pytest.raises(ProtocolError):
        parse_inbound_message(
            {
                "type": "system.semantic_axis_profile_save",
                "session_id": "session",
                "source": "frontend",
                "payload": {
                    "request_id": "request-1",
                    "model_name": "DemoModel",
                    "expected_revision": "3",
                    "profile": {"schema_version": "ag99.semantic_axis_profile.v1"},
                },
            },
            default_session_id="fallback-session",
        )


def test_parse_inbound_message_accepts_motion_tuning_examples_sync() -> None:
    envelope = parse_inbound_message(
        {
            "type": "system.motion_tuning_examples_sync",
            "session_id": "session",
            "source": "frontend",
            "payload": {
                "examples": [
                    {
                        "input": "Assistant: 好的",
                        "output": {
                            "emotion": "joy",
                            "mode": "expressive",
                            "duration_ms": 1200,
                            "axes": {"head_yaw": 64, "mouth_smile": 78},
                        },
                    }
                ],
            },
        },
        default_session_id="fallback-session",
    )

    assert envelope.type == "system.motion_tuning_examples_sync"
    assert envelope.payload["examples"][0]["output"]["axes"]["mouth_smile"] == 78
