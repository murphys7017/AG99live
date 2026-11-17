"""One Core-owned proactive turn, completed by frontend playback evidence."""

from __future__ import annotations

import asyncio


class ProactiveOutput:
    def __init__(self, adapter, event):
        self.adapter = adapter
        self.event = event
        self.turn_id = str(event.get_extra("_turn_id") or "")
        if not self.turn_id:
            raise ValueError("proactive_core_turn_id_missing")
        event.set_extra("output_correlation_id", self.turn_id)
        self.started = False
        self.closed = False
        self.segments: dict[str, int] = {}
        self.pending: set[str] = set()
        self.spoken_segments: dict[int, str] = {}

    async def send(self, message, extras):
        if self.closed or self.event.is_stopped():
            raise asyncio.CancelledError
        if not self.started:
            await self.adapter.turn_coordinator.begin_proactive_output_turn(
                turn_id=self.turn_id
            )
            self.adapter.turn_identity_map.bind_astrbot_turn(
                frontend_turn_id=self.turn_id,
                astrbot_turn_id=self.turn_id,
            )
            self.started = True
            self.event.consume_scheduling_opportunity()
        if self.adapter.session_state.current_turn_id != self.turn_id:
            raise asyncio.CancelledError
        extras = dict(extras or {})
        segment = extras.get("output_segment") or {}
        from astrbot.api.message_components import Plain, Record

        index = extras.get("persona_segment_index")
        records = [item for item in message.chain if isinstance(item, Record)]
        if type(index) is int and records:
            self.spoken_segments[index] = "".join(item.text or "" for item in records)
        elif self.spoken_segments and all(isinstance(item, Plain) for item in message.chain):
            integrated = "".join(item.text for item in message.chain)
            spoken = "".join(self.spoken_segments[key] for key in sorted(self.spoken_segments))
            if integrated == spoken:
                return  # Indexed Records already carry the same visible speech.
        message_id = str(
            segment.get("message_id") or extras.get("visible_message_id") or ""
        )
        if not message_id:
            raise ValueError("proactive_message_id_missing")
        self.segments.setdefault(message_id, len(self.segments))
        extras.update(
            logical_message_id=message_id,
            logical_segment_index=self.segments[message_id],
        )
        await self.adapter.emit_message_chain(
            message_chain=message,
            turn_id=self.turn_id,
            unified_msg_origin=self.event.unified_msg_origin,
            platform_extras=extras,
        )
        self.pending.add(message_id)

    async def flush(self):
        for message_id in tuple(self.pending):
            await self.adapter.finalize_output_segment(
                turn_id=self.turn_id, message_id=message_id
            )
            self.pending.remove(message_id)

    async def complete(self):
        if not self.started or self.closed:
            return
        await self.flush()
        await self.adapter.close_turn_output_queue(turn_id=self.turn_id)
        success, reason = await self.adapter.turn_coordinator.wait_for_turn_finished(
            turn_id=self.turn_id,
            timeout_seconds=120,
        )
        if not success:
            raise RuntimeError(f"proactive_playback_failed:{reason}")
        self.closed = True

    async def abort(self, reason):
        if self.started and not self.closed:
            await self.adapter.turn_coordinator.abort_turn_from_backend(
                turn_id=self.turn_id,
                reason=reason,
            )
        self.closed = True
