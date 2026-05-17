from __future__ import annotations

import pytest

from astrbot_plugin_ag99live_adapter.runtime.turn_identity_map import TurnIdentityMap


def test_register_and_bind_turn_identity_round_trip() -> None:
    identity_map = TurnIdentityMap()

    frontend_turn_id = identity_map.register_frontend_turn("  frontend-turn  ")
    assert frontend_turn_id == "frontend-turn"
    assert identity_map.resolve_astrbot_turn(frontend_turn_id) is None

    identity_map.bind_astrbot_turn(
        frontend_turn_id=frontend_turn_id,
        astrbot_turn_id="  astrbot-turn  ",
    )

    assert identity_map.resolve_astrbot_turn("frontend-turn") == "astrbot-turn"
    assert identity_map.resolve_frontend_turn("astrbot-turn") == "frontend-turn"


def test_binding_new_astrbot_turn_replaces_previous_reverse_mapping() -> None:
    identity_map = TurnIdentityMap()

    identity_map.bind_astrbot_turn(
        frontend_turn_id="frontend-turn",
        astrbot_turn_id="astrbot-turn-1",
    )
    identity_map.bind_astrbot_turn(
        frontend_turn_id="frontend-turn",
        astrbot_turn_id="astrbot-turn-2",
    )

    assert identity_map.resolve_astrbot_turn("frontend-turn") == "astrbot-turn-2"
    assert identity_map.resolve_frontend_turn("astrbot-turn-1") is None
    assert identity_map.resolve_frontend_turn("astrbot-turn-2") == "frontend-turn"


def test_binding_existing_astrbot_turn_moves_frontend_owner() -> None:
    identity_map = TurnIdentityMap()

    identity_map.bind_astrbot_turn(
        frontend_turn_id="frontend-turn-1",
        astrbot_turn_id="astrbot-turn",
    )
    identity_map.bind_astrbot_turn(
        frontend_turn_id="frontend-turn-2",
        astrbot_turn_id="astrbot-turn",
    )

    assert identity_map.resolve_astrbot_turn("frontend-turn-1") is None
    assert identity_map.resolve_astrbot_turn("frontend-turn-2") == "astrbot-turn"
    assert identity_map.resolve_frontend_turn("astrbot-turn") == "frontend-turn-2"


def test_clear_frontend_and_astrbot_turn_remove_both_directions() -> None:
    identity_map = TurnIdentityMap()

    identity_map.bind_astrbot_turn(
        frontend_turn_id="frontend-turn",
        astrbot_turn_id="astrbot-turn",
    )
    identity_map.clear_frontend_turn("frontend-turn")

    assert identity_map.resolve_astrbot_turn("frontend-turn") is None
    assert identity_map.resolve_frontend_turn("astrbot-turn") is None

    identity_map.bind_astrbot_turn(
        frontend_turn_id="frontend-turn",
        astrbot_turn_id="astrbot-turn",
    )
    identity_map.clear_astrbot_turn("astrbot-turn")

    assert identity_map.resolve_astrbot_turn("frontend-turn") is None
    assert identity_map.resolve_frontend_turn("astrbot-turn") is None


def test_clear_all_and_required_field_validation() -> None:
    identity_map = TurnIdentityMap()

    identity_map.register_bound_turn(
        frontend_turn_id="frontend-turn",
        backend_turn_id="astrbot-turn",
    )
    identity_map.clear_all()

    assert identity_map.resolve_astrbot_turn("frontend-turn") is None
    assert identity_map.resolve_frontend_turn("astrbot-turn") is None

    with pytest.raises(ValueError, match="frontend_turn_id is required"):
        identity_map.register_frontend_turn("  ")

    with pytest.raises(ValueError, match="astrbot_turn_id is required"):
        identity_map.bind_astrbot_turn(
            frontend_turn_id="frontend-turn",
            astrbot_turn_id="  ",
        )
