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
                "model_name": "DemoModel",
                "expected_revision": 3,
                "profile": {"schema_version": "ag99.semantic_axis_profile.v1"},
            },
        },
        default_session_id="fallback-session",
    )

    assert envelope.type == "system.semantic_axis_profile_save"
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
                    "model_name": "DemoModel",
                    "expected_revision": "3",
                    "profile": {"schema_version": "ag99.semantic_axis_profile.v1"},
                },
            },
            default_session_id="fallback-session",
        )
