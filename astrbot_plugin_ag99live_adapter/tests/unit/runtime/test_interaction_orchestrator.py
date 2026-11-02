from __future__ import annotations

import asyncio

import pytest

from astrbot_plugin_ag99live_adapter.adapters.astrbot.provider_bridge import (
    AstrBotConversationProvider,
    AstrBotMotionProvider,
    AstrBotSttProvider,
    AstrBotTtsProvider,
)
from astrbot_plugin_ag99live_adapter.providers.contracts import (
    AudioArtifact,
    ConversationEvent,
    ConversationEventKind,
    MotionRequest,
    MotionOrigin,
    SegmentBoundary,
    TtsRequest,
)
from astrbot_plugin_ag99live_adapter.runtime.interaction_orchestrator import (
    FrontendMessageHandlers,
    InteractionOrchestrator,
)


def test_orchestrator_routes_provider_facts_and_owns_unsubscribe() -> None:
    routed = []

    async def submit(_request):
        return None

    async def interrupt(_turn_id):
        return None

    async def close():
        return None

    async def recognize(_stream_id, _payload, _options):
        return ""

    async def synthesize(_request):
        return AudioArtifact(
            artifact_id="audio-1",
            uri="/cache/audio/audio-1.wav",
            format="audio/wav",
        )

    async def generate(_request):
        return {"intent_tags": ["calm"]}

    async def cancel(_request_id):
        return None

    async def run() -> None:
        conversation = AstrBotConversationProvider(
            submit_message=submit,
            interrupt=interrupt,
            close=close,
        )
        tts = AstrBotTtsProvider(synthesize=synthesize, cancel=cancel)
        motion = AstrBotMotionProvider(generate=generate, cancel=cancel)
        _ = AstrBotSttProvider(recognize_audio=recognize)
        orchestrator = InteractionOrchestrator(
            conversation_provider=conversation,
            tts_provider=tts,
            motion_provider=motion,
            event_sink=routed.append,
        )
        orchestrator.start()
        await conversation.publish_event(
            ConversationEvent(
                kind=ConversationEventKind.SEGMENT_BOUNDARY,
                turn_id="turn-1",
                provider_event_id="event-1",
                boundary=SegmentBoundary("segment-1"),
            )
        )
        await tts.synthesize(
            TtsRequest(
                request_id="tts-1",
                turn_id="turn-1",
                message_id="message-1",
                text="hello",
            )
        )
        await motion.generate(
            MotionRequest(
                request_id="motion-1",
                origin=MotionOrigin.TURN,
                turn_id="turn-1",
                message_id="message-1",
                text="hello",
            )
        )
        await orchestrator.close()
        await tts.synthesize(
            TtsRequest(
                request_id="tts-2",
                turn_id="turn-1",
                message_id="message-2",
                text="after close",
            )
        )

    asyncio.run(run())

    assert [event.source for event in routed] == [
        "conversation",
        "tts",
        "tts",
        "motion",
        "motion",
    ]


def test_orchestrator_rejects_sending_before_start() -> None:
    async def submit(_request):
        return None

    async def interrupt(_turn_id):
        return None

    async def close():
        return None

    async def run() -> None:
        orchestrator = InteractionOrchestrator(
            conversation_provider=AstrBotConversationProvider(
                submit_message=submit,
                interrupt=interrupt,
                close=close,
            ),
            tts_provider=AstrBotTtsProvider(
                synthesize=lambda _request: None,
                cancel=lambda _request_id: None,
            ),
            motion_provider=AstrBotMotionProvider(
                generate=lambda _request: None,
                cancel=lambda _request_id: None,
            ),
        )
        with pytest.raises(RuntimeError, match="not_started"):
            await orchestrator.send_message(object())

    asyncio.run(run())


def test_frontend_dispatcher_owns_message_order_and_finally_callbacks() -> None:
    async def run() -> list[str]:
        events: list[str] = []
        orchestrator = object.__new__(InteractionOrchestrator)
        message = type(
            "Message",
            (),
            {
                "type": "input.text",
                "turn_id": "turn-1",
                "payload": {},
                "raw": {"type": "input.text"},
            },
        )()
        handlers = FrontendMessageHandlers(
            require_turn_id=lambda value: value.turn_id,
            handle_system=lambda _message: asyncio.sleep(0),
            handle_audio_credit=lambda _turn_id, _payload: None,
            handle_playback_finished=lambda _turn_id, _payload: asyncio.sleep(0),
            handle_interrupt=lambda _turn_id: asyncio.sleep(0),
            handle_audio_start=lambda _message, _turn_id: asyncio.sleep(0),
            handle_audio_seal=lambda _message: asyncio.sleep(0),
            handle_audio_end=lambda _message, _turn_id: asyncio.sleep(0),
            handle_text=lambda _message, _turn_id: events.append("text"),
            handle_unhandled=lambda _type, _turn_id: asyncio.sleep(0),
            handle_error=lambda _turn_id, _message: None,
            handle_finally=lambda _message, _turn_id: events.append("finally"),
        )
        await orchestrator.dispatch_frontend_message(message, handlers)
        return events

    assert asyncio.run(run()) == ["text", "finally"]


def test_orchestrator_terminal_owner_preserves_control_and_cleanup_order() -> None:
    async def run() -> tuple[list[str], list[object], object]:
        order: list[str] = []
        controls: list[object] = []

        async def submit(_request):
            return None

        async def interrupt(_turn_id):
            return None

        async def close():
            return None

        class Output:
            async def publish_control(self, event):
                order.append("control")
                controls.append(event)

        conversation = AstrBotConversationProvider(
            submit_message=submit,
            interrupt=interrupt,
            close=close,
        )
        orchestrator = InteractionOrchestrator(
            conversation_provider=conversation,
            tts_provider=AstrBotTtsProvider(
                synthesize=lambda _request: None,
                cancel=lambda _request_id: None,
            ),
            motion_provider=AstrBotMotionProvider(
                generate=lambda _request: None,
                cancel=lambda _request_id: None,
            ),
            output_port=Output(),
        )
        orchestrator.attach_turn_lifecycle(
            cleanup_terminal_turn=lambda _turn_id, _event: order.append("cleanup"),
            mark_event_stop_requested=lambda _event: order.append("stop"),
        )
        event = type("Event", (), {})()
        event.stop_event = lambda: order.append("event_stop")
        orchestrator.register_active_event("turn-1", event)
        await orchestrator.finish_turn(
            turn_id="turn-1",
            success=False,
            reason="interrupted",
        )
        return order, controls, orchestrator.snapshot_turn("turn-1")

    order, controls, snapshot = asyncio.run(run())
    assert order == ["stop", "control", "cleanup"]
    assert controls[0].type == "control.turn_finished"
    assert controls[0].payload == {"success": False, "reason": "interrupted"}
    assert snapshot.terminal == (False, "interrupted")


def test_orchestrator_terminal_owner_rolls_back_when_output_port_rejects() -> None:
    async def run() -> dict:
        async def submit(_request):
            return None

        async def interrupt(_turn_id):
            return None

        async def close():
            return None

        class Output:
            async def publish_control(self, _event):
                raise RuntimeError("disconnected")

        orchestrator = InteractionOrchestrator(
            conversation_provider=AstrBotConversationProvider(
                submit_message=submit,
                interrupt=interrupt,
                close=close,
            ),
            tts_provider=AstrBotTtsProvider(
                synthesize=lambda _request: None,
                cancel=lambda _request_id: None,
            ),
            motion_provider=AstrBotMotionProvider(
                generate=lambda _request: None,
                cancel=lambda _request_id: None,
            ),
            output_port=Output(),
        )
        try:
            await orchestrator.finish_turn(
                turn_id="turn-fail",
                success=True,
                reason=None,
            )
        except RuntimeError:
            pass
        return orchestrator.terminal_results

    assert asyncio.run(run()) == {}


def test_orchestrator_protocol_errors_use_avatar_output_port() -> None:
    async def run() -> list:
        errors = []

        class Output:
            async def publish_error(self, error):
                errors.append(error)

        orchestrator = object.__new__(InteractionOrchestrator)
        orchestrator.output_port = Output()
        await orchestrator.publish_protocol_error(
            turn_id="turn-1",
            code="unhandled_message_type",
            message="unsupported",
        )
        return errors

    errors = asyncio.run(run())
    assert errors[0].code == "unhandled_message_type"
    assert errors[0].turn_id == "turn-1"


def test_orchestrator_owns_turn_and_segment_fact_snapshot() -> None:
    async def submit(_request):
        return None

    async def interrupt(_turn_id):
        return None

    async def close():
        return None

    async def run():
        conversation = AstrBotConversationProvider(
            submit_message=submit,
            interrupt=interrupt,
            close=close,
        )
        tts = AstrBotTtsProvider(
            synthesize=lambda _request: None,
            cancel=lambda _request_id: None,
        )
        motion = AstrBotMotionProvider(
            generate=lambda _request: None,
            cancel=lambda _request_id: None,
        )
        orchestrator = InteractionOrchestrator(
            conversation_provider=conversation,
            tts_provider=tts,
            motion_provider=motion,
        )
        orchestrator.start()
        orchestrator.admit_turn("turn-1", "hello")
        orchestrator.register_segment(
            turn_id="turn-1",
            message_id="message-1",
            sequence=0,
            published=True,
        )
        orchestrator.complete_turn("turn-1", success=True, reason=None)
        return orchestrator.snapshot_turn("turn-1")

    snapshot = asyncio.run(run())

    assert snapshot is not None
    assert snapshot.admitted is True
    assert snapshot.terminal == (True, None)
    assert snapshot.segments[0].message_id == "message-1"
    assert snapshot.segments[0].published is True


def test_terminal_registry_rolls_back_then_commits_waiters() -> None:
    async def submit(_request):
        return None

    async def interrupt(_turn_id):
        return None

    async def close():
        return None

    async def run():
        conversation = AstrBotConversationProvider(
            submit_message=submit,
            interrupt=interrupt,
            close=close,
        )
        tts = AstrBotTtsProvider(
            synthesize=lambda _request: None,
            cancel=lambda _request_id: None,
        )
        motion = AstrBotMotionProvider(
            generate=lambda _request: None,
            cancel=lambda _request_id: None,
        )
        orchestrator = InteractionOrchestrator(
            conversation_provider=conversation,
            tts_provider=tts,
            motion_provider=motion,
        )
        orchestrator.start()
        first_waiter = asyncio.create_task(
            orchestrator.wait_for_turn_finished(
                turn_id="turn-1",
                timeout_seconds=1.0,
            )
        )
        await asyncio.sleep(0)
        assert orchestrator.begin_terminal_publication("turn-1", (True, None)) == (
            True,
            None,
        )
        orchestrator.rollback_terminal_publication(
            "turn-1",
            "turn_finished_send_failed:turn-1",
        )
        assert await first_waiter == (False, "turn_finished_send_failed:turn-1")

        second_waiter = asyncio.create_task(
            orchestrator.wait_for_turn_finished(
                turn_id="turn-1",
                timeout_seconds=1.0,
            )
        )
        await asyncio.sleep(0)
        assert orchestrator.begin_terminal_publication("turn-1", (True, None)) == (
            True,
            None,
        )
        orchestrator.commit_terminal_publication("turn-1", (True, None))
        assert await second_waiter == (True, None)

    asyncio.run(run())


def test_orchestrator_clear_lifecycle_state_resolves_pending_waiters() -> None:
    async def submit(_request):
        return None

    async def interrupt(_turn_id):
        return None

    async def close():
        return None

    async def run():
        orchestrator = InteractionOrchestrator(
            conversation_provider=AstrBotConversationProvider(
                submit_message=submit,
                interrupt=interrupt,
                close=close,
            ),
            tts_provider=AstrBotTtsProvider(
                synthesize=lambda _request: None,
                cancel=lambda _request_id: None,
            ),
            motion_provider=AstrBotMotionProvider(
                generate=lambda _request: None,
                cancel=lambda _request_id: None,
            ),
        )
        orchestrator.start()
        waiter = asyncio.create_task(
            orchestrator.wait_for_turn_finished(
                turn_id="turn-reset",
                timeout_seconds=1.0,
            )
        )
        await asyncio.sleep(0)
        orchestrator.admit_turn("turn-reset", "hello")
        orchestrator.clear_lifecycle_state()
        return await waiter

    assert asyncio.run(run()) == (
        False,
        "interaction_orchestrator_reset_before_completion",
    )
