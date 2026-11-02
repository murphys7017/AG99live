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
                "arguments": '{"code":"print(1)"}',
            },
        }
        yield {
            "type": "tool/result",
            "data": {
                "message": {
                    "toolCallId": "call-1",
                    "content": [{"type": "text", "text": "1"}],
                    "isError": False,
                },
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
    assert executions[0].arguments == {"code": "print(1)"}
    assert executions[1].execution_id == "call-1"
    assert executions[1].name == "run_code"
    assert executions[1].output == "1"


def test_dsh_ptc_events_pair_by_sub_call_and_preserve_failed_code_output() -> None:
    async def replies(_request):
        yield {
            "type": "tool/call",
            "data": {
                "callId": "root-1",
                "name": "run_code",
                "arguments": '{"code":"await read()"}',
            },
        }
        yield {
            "type": "tool/ptc-dispatch-start",
            "data": {
                "rootCallId": "root-1",
                "parentCallId": "root-1",
                "subCallId": "root-1:ptc:1",
                "name": "read",
                "arguments": {"path": "missing.txt"},
            },
        }
        yield {
            "type": "tool/ptc-dispatch",
            "data": {
                "rootCallId": "root-1",
                "parentCallId": "root-1",
                "subCallId": "root-1:ptc:1",
                "name": "read",
                "arguments": {"path": "missing.txt"},
                "isError": True,
                "error": {"name": "NotFound", "code": "ENOENT", "reason": "missing"},
                "content": [{"type": "text", "text": "missing"}],
            },
        }
        yield {
            "type": "tool/result",
            "data": {
                "message": {
                    "toolCallId": "root-1",
                    "content": [{"type": "text", "text": "code finished"}],
                    "isError": False,
                },
            },
        }

    async def run() -> list:
        executions = []
        provider = DshConversationProvider(
            DshConversationCallbacks(
                send=replies,
                interrupt=lambda _turn_id: asyncio.sleep(0),
                close=lambda: asyncio.sleep(0),
            )
        )
        provider.subscribe_execution(executions.append)
        await provider.send_message(
            ConversationInput(turn_id="dsh-ptc-1", text="run it")
        )
        await provider.close()
        return executions

    executions = asyncio.run(run())
    assert [event.kind for event in executions] == [
        ExecutionEventKind.STARTED,
        ExecutionEventKind.STARTED,
        ExecutionEventKind.FAILED,
        ExecutionEventKind.COMPLETED,
    ]
    assert executions[1].execution_id == "root-1:ptc:1"
    assert executions[2].execution_id == "root-1:ptc:1"
    assert executions[2].output == "missing"
    assert executions[2].reason == "missing"


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


def test_dsh_ignores_sdk_lifecycle_notifications() -> None:
    async def replies(_request):
        yield {"type": "permission/preset", "data": {"preset": "default"}}
        yield {"type": "sandbox/mode", "data": {"mode": "workspace"}}
        yield {"type": "request/context", "data": {"cwd": "workspace"}}
        yield {"type": "assistant/message", "data": {"message": {"content": [{"type": "text", "text": "ok"}]}}}
        yield {"type": "turn/end", "data": {"reason": {"kind": "stop"}}}

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
        await provider.send_message(ConversationInput(turn_id="dsh-lifecycle-1", text="hi"))
        await provider.close()
        return events

    events = asyncio.run(run())
    assert [event.kind for event in events] == [
        ConversationEventKind.TEXT_COMPLETED,
        ConversationEventKind.TURN_COMPLETED,
    ]
    assert events[0].text == "ok"


def test_dsh_runtime_delivers_execution_events_and_final_text_together() -> None:
    async def replies(_request):
        yield {
            "type": "tool/call",
            "data": {
                "callId": "call-final-1",
                "name": "run_code",
                "arguments": '{"code":"print(2)"}',
            },
        }
        yield {
            "type": "tool/result",
            "data": {
                "message": {
                    "toolCallId": "call-final-1",
                    "content": [{"type": "text", "text": "2"}],
                    "isError": False,
                },
            },
        }
        yield {
            "type": "assistant/message",
            "data": {
                "message": {
                    "content": [{"type": "text", "text": "最终答案"}],
                }
            },
        }
        yield {"type": "turn/end", "data": {"reason": {"kind": "completed"}}}

    async def run() -> list:
        published = []

        class Output:
            async def publish_segment(self, segment):
                published.append(("segment", segment))

            async def publish_control(self, event):
                published.append(("control", event))

            async def publish_execution(self, event):
                published.append(("execution", event))

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
            ConversationInput(turn_id="dsh-final-1", text="run it")
        )
        await runtime.orchestrator.close()
        return published

    published = asyncio.run(run())
    assert [kind for kind, _value in published] == [
        "execution",
        "execution",
        "segment",
        "control",
    ]
    assert published[0][1].execution_id == "call-final-1"
    assert published[0][1].arguments == {"code": "print(2)"}
    assert published[1][1].output == "2"
    assert published[2][1].payload["text"] == {
        "state": "present",
        "content": "最终答案",
    }
    assert published[3][1].type == "control.synth_finished"
