from __future__ import annotations

import asyncio

from astrbot_plugin_ag99live_adapter.adapters.dsh import (
    DshConversationCallbacks,
    DshConversationProvider,
    DshConversationRuntime,
)
from astrbot_plugin_ag99live_adapter.adapters.astrbot.provider_bridge import (
    AstrBotMotionProvider,
    AstrBotTtsProvider,
)
from astrbot_plugin_ag99live_adapter.providers.contracts import (
    ConversationEventKind,
    ConversationInput,
    ExecutionEventKind,
)


def test_dsh_stream_maps_neutral_events_without_creating_output_segments() -> None:
    async def replies(_request):
        yield {"kind": "turn_started"}
        yield {
            "kind": "text_completed",
            "text": "hello",
            "metadata": {"source": "dsh"},
        }
        yield {
            "kind": "segment_boundary",
            "boundary": {"id": "dsh-segment-1", "reason": "sentence"},
        }
        yield {"kind": "turn_completed"}

    async def run() -> list:
        events = []
        provider = DshConversationProvider(
            DshConversationCallbacks(
                send=replies,
                interrupt=lambda _turn_id: asyncio.sleep(0),
                close=lambda: asyncio.sleep(0),
            )
        )
        provider.subscribe(events.append)
        await provider.send_message(
            ConversationInput(turn_id="dsh-turn-1", text="hi")
        )
        await provider.close()
        return events

    events = asyncio.run(run())
    assert [event.kind for event in events] == [
        ConversationEventKind.TURN_STARTED,
        ConversationEventKind.TEXT_COMPLETED,
        ConversationEventKind.SEGMENT_BOUNDARY,
        ConversationEventKind.TURN_COMPLETED,
    ]
    assert events[2].boundary.provider_boundary_id == "dsh-segment-1"


def test_dsh_runtime_uses_shared_avatar_output_port_for_text_segments() -> None:
    async def replies(_request):
        yield {"kind": "turn_started"}
        yield {"kind": "text_delta", "text": "hello"}
        yield {"kind": "text_completed", "text": "hello"}
        yield {"kind": "turn_completed"}

    async def run() -> list:
        published = []

        class Output:
            async def publish_segment(self, segment):
                published.append(("segment", segment))

            async def publish_control(self, event):
                published.append(("control", event))

            async def publish_error(self, error):
                published.append(("error", error))

        runtime = DshConversationRuntime.build(
            callbacks=DshConversationCallbacks(
                send=replies,
                interrupt=lambda _turn_id: asyncio.sleep(0),
                close=lambda: asyncio.sleep(0),
            ),
            output_port=Output(),
            tts_provider=AstrBotTtsProvider(
                synthesize=lambda _request: None,
                cancel=lambda _request_id: None,
            ),
            motion_provider=AstrBotMotionProvider(
                generate=lambda _request: None,
                cancel=lambda _request_id: None,
            ),
        )
        await runtime.orchestrator.send_message(
            ConversationInput(turn_id="dsh-runtime-1", text="hi")
        )
        await runtime.orchestrator.close()
        return published

    published = asyncio.run(run())
    assert [kind for kind, _value in published] == ["control", "segment", "control"]
    assert published[0][1].type == "control.turn_started"
    segment = published[1][1]
    assert segment.turn_id == "dsh-runtime-1"
    assert segment.payload["text"] == {"state": "present", "content": "hello"}
    assert published[2][1].type == "control.synth_finished"


def test_dsh_tool_events_use_execution_stream_without_becoming_conversation_text() -> None:
    async def replies(_request):
        yield {
            "type": "tool/call",
            "data": {
                "callId": "call-1",
                "name": "run_code",
                "arguments": {"code": "print(1)"},
            },
        }
        yield {
            "type": "tool/result",
            "data": {
                "callId": "call-1",
                "name": "run_code",
                "content": [{"type": "text", "text": "1"}],
            },
        }

    async def run() -> tuple[list, list]:
        conversations = []
        executions = []
        provider = DshConversationProvider(
            DshConversationCallbacks(
                send=replies,
                interrupt=lambda _turn_id: asyncio.sleep(0),
                close=lambda: asyncio.sleep(0),
            )
        )
        provider.subscribe(conversations.append)
        provider.subscribe_execution(executions.append)
        await provider.send_message(
            ConversationInput(turn_id="dsh-execution-1", text="run it")
        )
        await provider.close()
        return conversations, executions

    conversations, executions = asyncio.run(run())
    assert conversations == []
    assert [event.kind for event in executions] == [
        ExecutionEventKind.STARTED,
        ExecutionEventKind.COMPLETED,
    ]
    assert executions[0].name == "run_code"
    assert executions[1].output == "1"


def test_dsh_assistant_attempt_stream_and_stop_terminal_are_conversation_facts() -> None:
    async def replies(_request):
        yield {
            "type": "assistant/attempt",
            "data": {
                "stream": [
                    {
                        "type": "text-chunks",
                        "texts": ["DSH", "_READY"],
                    }
                ]
            },
        }
        yield {
            "type": "turn/end",
            "data": {"reason": {"kind": "stop"}},
        }

    async def run() -> list:
        events = []
        provider = DshConversationProvider(
            DshConversationCallbacks(
                send=replies,
                interrupt=lambda _turn_id: asyncio.sleep(0),
                close=lambda: asyncio.sleep(0),
            )
        )
        provider.subscribe(events.append)
        await provider.send_message(
            ConversationInput(turn_id="dsh-assistant-attempt-1", text="hi")
        )
        await provider.close()
        return events

    events = asyncio.run(run())
    assert [event.kind for event in events] == [
        ConversationEventKind.TEXT_COMPLETED,
        ConversationEventKind.TURN_COMPLETED,
    ]
    assert events[0].text == "DSH_READY"
