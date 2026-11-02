"""Text-only ConversationEvent to output.segment.v6 assembly."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Awaitable, Callable

from ..providers.contracts import (
    AvatarOutputPort,
    ConversationEvent,
    ConversationEventKind,
    ControlEvent,
    OutputSegmentEnvelope,
)
from ..protocol.constants import TYPE_CONTROL_SYNTH_FINISHED, TYPE_CONTROL_TURN_STARTED


@dataclass(slots=True)
class _ConversationTurn:
    text: str = ""
    sequence: int = 0
    next_message_id: str = ""


class TextConversationEventAssembler:
    """Assemble a DSH text stream into the existing v6 output boundary."""

    def __init__(
        self,
        output_port: AvatarOutputPort,
        *,
        publish_segment: Callable[[OutputSegmentEnvelope], Awaitable[None]] | None = None,
        close_turn: Callable[[str, str | None], Awaitable[None]] | None = None,
        publish_turn_started: bool = True,
    ) -> None:
        self._output_port = output_port
        self._publish_segment = publish_segment
        self._close_turn = close_turn
        self._publish_turn_started = publish_turn_started
        self._turns: dict[str, _ConversationTurn] = {}

    async def handle_event(self, event: ConversationEvent) -> None:
        state = self._turns.setdefault(event.turn_id, _ConversationTurn())
        if event.kind is ConversationEventKind.TURN_STARTED:
            self._turns[event.turn_id] = _ConversationTurn()
            if self._publish_turn_started:
                await self._output_port.publish_control(
                    ControlEvent(
                        type=TYPE_CONTROL_TURN_STARTED,
                        turn_id=event.turn_id,
                    )
                )
            return
        if event.kind is ConversationEventKind.TEXT_DELTA:
            state.text += event.text
            return
        if event.kind is ConversationEventKind.TEXT_COMPLETED:
            state.text = _merge_completed_text(state.text, event.text)
            return
        if event.kind is ConversationEventKind.SEGMENT_BOUNDARY:
            state.next_message_id = (
                event.boundary.provider_boundary_id
                if event.boundary is not None
                else ""
            )
            await self._flush(event.turn_id, state)
            return
        if event.kind is ConversationEventKind.TURN_COMPLETED:
            await self._flush(event.turn_id, state)
            await self._close_or_publish_synth_finished(event.turn_id, success=True)
            self._turns.pop(event.turn_id, None)
            return
        if event.kind in {
            ConversationEventKind.TURN_FAILED,
            ConversationEventKind.INTERRUPTED,
        }:
            await self._flush(event.turn_id, state)
            await self._close_or_publish_synth_finished(
                event.turn_id,
                success=False,
                reason=event.reason or event.kind.value,
            )
            self._turns.pop(event.turn_id, None)

    async def close(self) -> None:
        self._turns.clear()

    async def _flush(self, turn_id: str, state: _ConversationTurn) -> None:
        text = state.text
        if not text:
            state.next_message_id = ""
            return
        message_id = state.next_message_id or (
            f"{turn_id}:segment:{state.sequence}"
        )
        segment = OutputSegmentEnvelope(
            turn_id=turn_id,
            message_id=message_id,
            sequence=state.sequence,
            payload={
                "text": {"state": "present", "content": text},
                "audio": {"state": "absent"},
                "motion": {"state": "absent"},
                "speech": {"state": "absent"},
                "images": [],
                "speaker_name": "",
                "avatar": "",
            },
        )
        if self._publish_segment is not None:
            await self._publish_segment(segment)
        else:
            await self._output_port.publish_segment(segment)
        state.sequence += 1
        state.text = ""
        state.next_message_id = ""

    async def _publish_synth_finished(
        self,
        turn_id: str,
        *,
        success: bool,
        reason: str | None = None,
    ) -> None:
        payload: dict[str, Any] = {"success": success, "reason": reason or ""}
        await self._output_port.publish_control(
            ControlEvent(
                type=TYPE_CONTROL_SYNTH_FINISHED,
                turn_id=turn_id,
                payload=payload,
            )
        )

    async def _close_or_publish_synth_finished(
        self,
        turn_id: str,
        *,
        success: bool,
        reason: str | None = None,
    ) -> None:
        if self._close_turn is not None:
            await self._close_turn(turn_id, None if success else reason)
            return
        await self._publish_synth_finished(
            turn_id,
            success=success,
            reason=reason,
        )


def _merge_completed_text(current: str, completed: str) -> str:
    if not completed:
        return current
    if not current:
        return completed
    if completed.startswith(current):
        return completed
    if current.endswith(completed):
        return current
    return current + completed


__all__ = ["TextConversationEventAssembler"]
