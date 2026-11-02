from __future__ import annotations

import asyncio

from astrbot_plugin_ag99live_adapter.providers.contracts import ConversationInput
from astrbot_plugin_ag99live_adapter.runtime.turn_coordinator import TurnCoordinator


def test_provider_text_submission_reuses_existing_input_text_commit_path() -> None:
    captured: list[tuple[dict, str]] = []

    async def run() -> None:
        coordinator = TurnCoordinator.__new__(TurnCoordinator)
        coordinator._convert_message = lambda raw: raw

        async def commit(message_obj, *, turn_id):
            captured.append((message_obj, turn_id))

        coordinator._commit_inbound_message = commit
        await coordinator.submit_provider_message(
            ConversationInput(
                turn_id="turn-provider-1",
                message_id="provider-message-1",
                text="hello from provider",
                metadata={"images": []},
            )
        )

    asyncio.run(run())

    raw_message, committed_turn_id = captured[0]
    assert committed_turn_id == "turn-provider-1"
    assert raw_message["type"] == "input.text"
    assert raw_message["version"] == "v2"
    assert raw_message["source"] == "frontend"
    assert raw_message["turn_id"] == "turn-provider-1"
    assert raw_message["message_id"] == "provider-message-1"
    assert raw_message["payload"] == {
        "text": "hello from provider",
        "images": [],
    }
