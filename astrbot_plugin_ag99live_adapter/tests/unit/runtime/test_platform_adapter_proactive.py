from __future__ import annotations

import asyncio
import importlib
import sys

import pytest

class _SessionStub:
    def __str__(self) -> str:
        return "olv_pet_adapter:friend_message:test-client"


class _CoordinatorStub:
    def __init__(self, *, begin_error: Exception | None = None) -> None:
        self.begin_error = begin_error
        self.started_turn_ids: list[str] = []
        self.emit_calls: list[dict[str, object]] = []
        self.closed_turn_ids: list[str] = []
        self.failed_turns: list[tuple[str, str]] = []

    async def begin_proactive_output_turn(self) -> str:
        if self.begin_error is not None:
            raise self.begin_error
        turn_id = f"proactive:test-{len(self.started_turn_ids) + 1}"
        self.started_turn_ids.append(turn_id)
        return turn_id

    async def emit_message_chain(self, **kwargs) -> None:
        self.emit_calls.append(kwargs)

    async def close_turn_output_queue(self, *, turn_id: str) -> None:
        self.closed_turn_ids.append(turn_id)

    async def fail_proactive_output_turn(self, *, turn_id: str, reason: str) -> None:
        self.failed_turns.append((turn_id, reason))


@pytest.fixture(scope="module")
def adapter_module():
    module = importlib.import_module(
        "astrbot_plugin_ag99live_adapter.platform_adapter"
    )
    yield module
    for module_name in (
        "astrbot_plugin_ag99live_adapter.platform_adapter",
        "astrbot_plugin_ag99live_adapter.runtime.turn_coordinator",
        "astrbot_plugin_ag99live_adapter.runtime.message_utils",
    ):
        sys.modules.pop(module_name, None)


def _build_adapter(monkeypatch, coordinator: _CoordinatorStub, adapter_module):
    async def base_send_by_session(_self, _session, _message_chain) -> None:
        return None

    monkeypatch.setattr(
        adapter_module.Platform,
        "send_by_session",
        base_send_by_session,
    )
    adapter = object.__new__(adapter_module.OLVPetPlatformAdapter)
    adapter.turn_coordinator = coordinator
    return adapter


def test_metadata_declares_personal_runtime_support(adapter_module) -> None:
    adapter = object.__new__(adapter_module.OLVPetPlatformAdapter)

    metadata = adapter.meta()

    assert metadata.support_proactive_message is True
    assert metadata.support_personal_runtime is True


def test_send_by_session_delivers_plain_and_record_as_independent_turns(
    monkeypatch,
    adapter_module,
) -> None:
    from astrbot.api.message_components import Plain, Record

    coordinator = _CoordinatorStub()
    adapter = _build_adapter(monkeypatch, coordinator, adapter_module)
    chains = [
        [Plain("proactive text")],
        [Record(file="voice.wav", text="proactive voice")],
    ]

    async def send_all() -> None:
        for chain in chains:
            await adapter.send_by_session(_SessionStub(), chain)

    asyncio.run(send_all())

    assert coordinator.started_turn_ids == ["proactive:test-1", "proactive:test-2"]
    assert coordinator.closed_turn_ids == coordinator.started_turn_ids
    assert coordinator.failed_turns == []
    assert [call["message_chain"] for call in coordinator.emit_calls] == chains
    assert [
        call["turn_id"] for call in coordinator.emit_calls
    ] == coordinator.started_turn_ids
    logical_message_ids = [
        call["platform_extras"]["logical_message_id"]
        for call in coordinator.emit_calls
    ]
    assert all(
        message_id.startswith("proactive_reply:")
        for message_id in logical_message_ids
    )
    assert len(set(logical_message_ids)) == len(logical_message_ids)


def test_send_by_session_raises_when_frontend_is_unavailable(
    monkeypatch,
    adapter_module,
) -> None:
    from astrbot.api.message_components import Plain

    coordinator = _CoordinatorStub(
        begin_error=RuntimeError("turn_started_send_failed:proactive:test")
    )
    adapter = _build_adapter(monkeypatch, coordinator, adapter_module)

    with pytest.raises(RuntimeError, match="turn_started_send_failed"):
        asyncio.run(
            adapter.send_by_session(
                _SessionStub(),
                [Plain("undeliverable")],
            )
        )

    assert coordinator.emit_calls == []
    assert coordinator.closed_turn_ids == []
    assert coordinator.failed_turns == []
