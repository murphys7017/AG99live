import pytest

from astrbot_plugin_ag99live_adapter.motion.motion_intent import (
    normalize_motion_intent_payload,
)


def test_profile_revision_requires_positive_integer():
    payload = {
        "schema_version": "engine.motion_intent.v4",
        "profile_id": "profile-1",
        "profile_revision": 1,
        "model_id": "model-1",
        "intent_tags": ["test"],
        "axis_levels": {"head_yaw": 1},
    }
    assert normalize_motion_intent_payload(payload)["profile_revision"] == 1
    with pytest.raises(ValueError, match="^profile_revision_invalid$"):
        normalize_motion_intent_payload({**payload, "profile_revision": True})
