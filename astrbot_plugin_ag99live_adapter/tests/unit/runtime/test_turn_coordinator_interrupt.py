from __future__ import annotations

import asyncio
import sys
import types


def test_backend_abort_is_idempotent_while_terminal_publication_is_pending(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    install_fake_astrbot()
    components_module = types.ModuleType("astrbot.api.message_components")
    components_module.Image = type("Image", (), {})
    components_module.Plain = type("Plain", (), {})
    components_module.Record = type("Record", (), {})
    monkeypatch.setitem(sys.modules, "astrbot.api.message_components", components_module)
    from astrbot_plugin_ag99live_adapter.runtime.turn_coordinator import (
        TurnCoordinator,
    )

    emitted: list[dict] = []

    async def send_json(payload: dict) -> bool:
        emitted.append(payload)
        await asyncio.sleep(0)
        return True

    runtime = types.SimpleNamespace(
        _turn_terminal_results={},
        _terminating_turn_ids=set(),
        _events_by_turn_id={},
        _turn_timings={},
        turn_identity_map=types.SimpleNamespace(clear_frontend_turn=lambda _turn_id: None),
        session_state=types.SimpleNamespace(current_turn_id=None, reset_to_idle=lambda: None),
        output_segments=types.SimpleNamespace(clear_turn=lambda _turn_id: None),
        performance_curves=types.SimpleNamespace(cancel_turn=lambda _turn_id: None),
    )
    runtime._send_json = send_json
    runtime._require_turn_id_value = TurnCoordinator._require_turn_id_value
    runtime._prune_turn_terminal_results = lambda: None
    runtime._clear_active_vad_turn = lambda _turn_id: None
    runtime._finish_turn = types.MethodType(TurnCoordinator._finish_turn, runtime)

    async def run_case() -> None:
        results = await asyncio.gather(
            TurnCoordinator.abort_turn_from_backend(
                runtime,
                turn_id="old-turn",
                reason="superseded_by_new_user_input",
            ),
            TurnCoordinator.abort_turn_from_backend(
                runtime,
                turn_id="old-turn",
                reason="superseded_by_new_user_input",
            ),
        )
        assert results == [0, 0]

    asyncio.run(run_case())

    assert [payload["type"] for payload in emitted] == [
        "control.interrupt",
        "control.turn_finished",
    ]
    assert runtime._turn_terminal_results == {
        "old-turn": (False, "superseded_by_new_user_input"),
    }
