"""Neutral Interaction Orchestrator boundary.

This module owns Provider subscriptions, neutral request entry points,
connection-owned lifecycle facts and the delegation boundary to the existing
SegmentAssembler. TurnCoordinator remains the AstrBot behavior adapter while
the migration preserves its protocol and output decisions.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from typing import Any

from ..providers.contracts import (
    AvatarOutputPort,
    ConversationEvent,
    ConversationEventKind,
    ConversationProvider,
    ControlEvent,
    ExecutionEvent,
    MotionLifecycleEvent,
    MotionProvider,
    ProtocolError,
    SttProvider,
    SttResult,
    TtsLifecycleEvent,
    TtsProvider,
    Unsubscribe,
)
from ..protocol.constants import (
    TYPE_CONTROL_AUDIO_CREDIT,
    TYPE_CONTROL_INTERRUPT,
    TYPE_CONTROL_PLAYBACK_FINISHED,
    TYPE_CONTROL_TURN_FINISHED,
    TYPE_CONTROL_TURN_STARTED,
    TYPE_INPUT_AUDIO_STREAM_END,
    TYPE_INPUT_AUDIO_STREAM_SEAL,
    TYPE_INPUT_AUDIO_STREAM_START,
    TYPE_INPUT_TEXT,
)
from ..protocol.parser import parse_inbound_message


@dataclass(frozen=True)
class ProviderEvent:
    """A tagged Provider fact routed to the future Orchestrator core."""

    source: str
    value: ConversationEvent | ExecutionEvent | TtsLifecycleEvent | MotionLifecycleEvent | SttResult


@dataclass(frozen=True)
class SegmentSnapshot:
    message_id: str
    sequence: int | None
    published: bool
    tts_event: TtsLifecycleEvent | None
    motion_event: MotionLifecycleEvent | None


@dataclass(frozen=True)
class TurnSnapshot:
    turn_id: str
    user_text: str
    admitted: bool
    terminal: tuple[bool, str | None] | None
    segments: tuple[SegmentSnapshot, ...]


ProviderEventSink = Callable[[ProviderEvent], Awaitable[None] | None]
ActiveEventMotionCancel = Callable[[Any, str, str], None]


@dataclass(frozen=True)
class FrontendMessageHandlers:
    """AstrBot-owned operations used by the neutral protocol dispatcher."""

    require_turn_id: Callable[[Any], str]
    handle_system: Callable[[Any], Awaitable[None]]
    handle_audio_credit: Callable[[str, Mapping[str, Any]], Awaitable[None] | None]
    handle_playback_finished: Callable[
        [str, Mapping[str, Any]], Awaitable[None]
    ]
    handle_interrupt: Callable[[str], Awaitable[None]]
    handle_audio_start: Callable[[Any, str], Awaitable[None]]
    handle_audio_seal: Callable[[Any], Awaitable[None]]
    handle_audio_end: Callable[[Any, str], Awaitable[None]]
    handle_text: Callable[[Any, str], Awaitable[None]]
    handle_unhandled: Callable[[str, str], Awaitable[None]]
    handle_error: Callable[[str, Any], Awaitable[None] | None]
    handle_finally: Callable[[Any, str], Awaitable[None] | None]


TerminalCleanup = Callable[[str, Any | None], Awaitable[None] | None]
StopEventRequested = Callable[[Any], None]
ControlSender = Callable[[ControlEvent], Awaitable[bool | None] | bool | None]


class InteractionOrchestrator:
    """Own neutral Provider, Turn terminal, protocol dispatch and output boundaries."""

    def __init__(
        self,
        *,
        conversation_provider: ConversationProvider,
        stt_provider: SttProvider | None = None,
        tts_provider: TtsProvider,
        motion_provider: MotionProvider,
        output_port: AvatarOutputPort | None = None,
        event_sink: ProviderEventSink | None = None,
        active_event_motion_cancel: ActiveEventMotionCancel | None = None,
    ) -> None:
        self.conversation_provider = conversation_provider
        self.stt_provider = stt_provider
        self.tts_provider = tts_provider
        self.motion_provider = motion_provider
        self.output_port = output_port
        self._event_sink = event_sink
        self._active_event_motion_cancel = active_event_motion_cancel
        self._unsubscribers: list[Unsubscribe] = []
        self._started = False
        self._closed = False
        self._turns: dict[str, _TurnState] = {}
        self._segment_assembler: Any | None = None
        self._conversation_event_assembler: Any | None = None
        self.active_events: dict[str, Any] = {}
        self.turn_timings: dict[str, dict[str, Any]] = {}
        self._sink_tasks: set[asyncio.Task] = set()
        self.terminal_results: dict[str, tuple[bool, str | None] | None] = {}
        self.terminal_waiters: dict[
            str, list[asyncio.Future[tuple[bool, str | None]]]
        ] = {}
        self.terminating_turn_ids: set[str] = set()
        self._terminal_cleanup: TerminalCleanup | None = None
        self._stop_event_requested: StopEventRequested | None = None
        self._control_sender: ControlSender | None = None

    def start(self) -> None:
        if self._closed:
            raise RuntimeError("interaction_orchestrator_closed")
        if self._started:
            return
        self._unsubscribers = [
            self.conversation_provider.subscribe(
                lambda event: self._route("conversation", event)
            ),
            self.tts_provider.subscribe(lambda event: self._route("tts", event)),
            self.motion_provider.subscribe(
                lambda event: self._route("motion", event)
            ),
        ]
        subscribe_execution = getattr(
            self.conversation_provider, "subscribe_execution", None
        )
        if callable(subscribe_execution):
            self._unsubscribers.append(
                subscribe_execution(lambda event: self._route("execution", event))
            )
        if self.stt_provider is not None:
            self._unsubscribers.append(
                self.stt_provider.on_final(lambda result: self._route("stt", result))
            )
        self._started = True

    async def send_message(self, request: Any) -> None:
        self._require_started()
        await self.conversation_provider.send_message(request)

    async def synthesize_tts(self, request: Any) -> Any:
        self._require_started()
        return await self.tts_provider.synthesize(request)

    async def generate_motion(self, request: Any) -> Any:
        self._require_started()
        return await self.motion_provider.generate(request)

    async def start_stt_session(self, stream_id: str, options: Any = None) -> None:
        self._require_started()
        if self.stt_provider is None:
            raise RuntimeError("interaction_orchestrator_stt_provider_missing")
        await self.stt_provider.start_session(stream_id, options)

    async def push_stt_audio(self, stream_id: str, chunk: bytes) -> None:
        self._require_started()
        if self.stt_provider is None:
            raise RuntimeError("interaction_orchestrator_stt_provider_missing")
        await self.stt_provider.push_audio(stream_id, chunk)

    async def finish_stt_session(self, stream_id: str) -> SttResult:
        self._require_started()
        if self.stt_provider is None:
            raise RuntimeError("interaction_orchestrator_stt_provider_missing")
        return await self.stt_provider.finish_session(stream_id)

    async def cancel_stt_session(self, stream_id: str) -> None:
        self._require_started()
        if self.stt_provider is None:
            raise RuntimeError("interaction_orchestrator_stt_provider_missing")
        await self.stt_provider.cancel_session(stream_id)

    async def publish_conversation_event(self, event: ConversationEvent) -> None:
        """Record an AstrBot fact through the same neutral event route."""

        publisher = getattr(self.conversation_provider, "publish_event", None)
        if callable(publisher):
            try:
                await publisher(event)
            except Exception:  # noqa: BLE001 - observation cannot alter the turn.
                return

    async def route_frontend_message(
        self,
        raw_message: dict[str, Any],
        dispatch: Callable[[Any], Awaitable[None]] | FrontendMessageHandlers,
    ) -> None:
        """Own protocol parsing and message-order behavior at the neutral boundary."""

        message = parse_inbound_message(raw_message)
        if isinstance(dispatch, FrontendMessageHandlers):
            await self.dispatch_frontend_message(message, dispatch)
            return
        await dispatch(message)

    @staticmethod
    async def dispatch_frontend_message(
        message: Any,
        handlers: FrontendMessageHandlers,
    ) -> None:
        """Route one parsed frontend message without knowing AstrBot details."""

        if message.type.startswith("system."):
            await _await_handler(handlers.handle_system(message))
            return

        turn_id = handlers.require_turn_id(message)
        if message.type == TYPE_CONTROL_AUDIO_CREDIT:
            await _await_handler(handlers.handle_audio_credit(turn_id, message.payload))
            return
        if message.type == TYPE_CONTROL_PLAYBACK_FINISHED:
            await _await_handler(
                handlers.handle_playback_finished(turn_id, message.payload)
            )
            return
        if message.type == TYPE_CONTROL_INTERRUPT:
            await _await_handler(handlers.handle_interrupt(turn_id))
            return

        try:
            if message.type == TYPE_INPUT_AUDIO_STREAM_START:
                await _await_handler(handlers.handle_audio_start(message, turn_id))
                return
            if message.type == TYPE_INPUT_AUDIO_STREAM_SEAL:
                await _await_handler(handlers.handle_audio_seal(message))
                return
            if message.type == TYPE_INPUT_AUDIO_STREAM_END:
                await _await_handler(handlers.handle_audio_end(message, turn_id))
                return
            if message.type == TYPE_INPUT_TEXT:
                await _await_handler(handlers.handle_text(message, turn_id))
                return
            await _await_handler(handlers.handle_unhandled(message.type, turn_id))
        except asyncio.CancelledError:
            raise
        except Exception:
            result = handlers.handle_error(turn_id, message)
            await _await_handler(result)
            raise
        finally:
            result = handlers.handle_finally(message, turn_id)
            await _await_handler(result)

    def attach_segment_assembler(self, assembler: Any) -> None:
        self._segment_assembler = assembler

    def attach_conversation_event_assembler(self, assembler: Any | None) -> None:
        """Attach an optional text-stream assembler for non-AstrBot providers."""

        self._conversation_event_assembler = assembler

    def attach_turn_lifecycle(
        self,
        *,
        cleanup_terminal_turn: TerminalCleanup,
        mark_event_stop_requested: StopEventRequested,
        control_sender: ControlSender | None = None,
    ) -> None:
        """Attach host cleanup callbacks while retaining neutral terminal ownership."""

        self._terminal_cleanup = cleanup_terminal_turn
        self._stop_event_requested = mark_event_stop_requested
        self._control_sender = control_sender

    async def finish_turn(
        self,
        *,
        turn_id: str,
        success: bool,
        reason: str | None,
    ) -> None:
        """Publish one terminal Turn result with rollback-safe ownership."""

        normalized_turn_id = str(turn_id or "").strip()
        if not normalized_turn_id:
            raise ValueError("turn_id is required")
        normalized_reason = str(reason or "").strip() or None
        terminal_result = (bool(success), normalized_reason)
        started, existing_result = self.begin_terminal_publication(
            normalized_turn_id,
            terminal_result,
        )
        if not started:
            if existing_result is None:
                return
            return

        event = self.active_events.get(normalized_turn_id)
        if event is not None:
            if self._active_event_motion_cancel is not None:
                self._active_event_motion_cancel(
                    event,
                    normalized_turn_id,
                    normalized_reason or "turn_finished",
                )
            if self._stop_event_requested is not None:
                self._stop_event_requested(event)

        try:
            await self._send_control(
                ControlEvent(
                    type=TYPE_CONTROL_TURN_FINISHED,
                    turn_id=normalized_turn_id,
                    payload=_terminal_payload(success=bool(success), reason=normalized_reason),
                ),
                required=True,
            )
        except Exception:
            failure_reason = f"turn_finished_send_failed:{normalized_turn_id}"
            self.rollback_terminal_publication(normalized_turn_id, failure_reason)
            raise

        self.commit_terminal_publication(normalized_turn_id, terminal_result)
        self.complete_turn(
            normalized_turn_id,
            success=bool(success),
            reason=normalized_reason,
        )
        await self.publish_conversation_event(
            ConversationEvent(
                kind=(
                    ConversationEventKind.TURN_COMPLETED
                    if success
                    else (
                        ConversationEventKind.INTERRUPTED
                        if normalized_reason
                        in {
                            "interrupted",
                            "superseded_by_new_user_input",
                            "provider_interrupt",
                        }
                        else ConversationEventKind.TURN_FAILED
                    )
                ),
                turn_id=normalized_turn_id,
                provider_event_id=f"turn-finished:{normalized_turn_id}",
                reason=normalized_reason,
            )
        )
        self.remove_active_event(normalized_turn_id)
        if self._terminal_cleanup is not None:
            await _await_handler(
                self._terminal_cleanup(normalized_turn_id, event)
            )

    async def abort_turn(self, *, turn_id: str, reason: str) -> int:
        """Interrupt an active Turn and then use the same terminal owner."""

        normalized_turn_id = str(turn_id or "").strip()
        if not normalized_turn_id or not self.begin_turn_termination(normalized_turn_id):
            return 0
        normalized_reason = str(reason or "").strip() or "interrupted"
        stopped_count = 0
        try:
            event = self.active_events.get(normalized_turn_id)
            if event is not None:
                if self._active_event_motion_cancel is not None:
                    self._active_event_motion_cancel(
                        event,
                        normalized_turn_id,
                        normalized_reason,
                    )
                if self._stop_event_requested is not None:
                    self._stop_event_requested(event)
                stop_event = getattr(event, "stop_event", None)
                if callable(stop_event):
                    stop_event()
                    stopped_count = 1
            await self._send_control(
                ControlEvent(type=TYPE_CONTROL_INTERRUPT, turn_id=normalized_turn_id),
                required=False,
            )
            await self.finish_turn(
                turn_id=normalized_turn_id,
                success=False,
                reason=normalized_reason,
            )
            return stopped_count
        finally:
            self.end_turn_termination(normalized_turn_id)

    async def publish_turn_started(self, turn_id: str) -> None:
        normalized_turn_id = str(turn_id or "").strip()
        if not normalized_turn_id:
            raise ValueError("turn_id is required")
        await self._send_control(
            ControlEvent(type=TYPE_CONTROL_TURN_STARTED, turn_id=normalized_turn_id),
            required=True,
        )

    async def publish_protocol_error(
        self,
        *,
        turn_id: str | None,
        code: str,
        message: str,
    ) -> None:
        if self.output_port is None:
            raise RuntimeError("interaction_orchestrator_output_port_missing")
        error = ProtocolError(
            code=str(code or "protocol_error"),
            message=str(message or "Protocol error"),
            turn_id=turn_id,
        )
        await self.output_port.publish_error(error)

    async def _send_control(self, event: ControlEvent, *, required: bool) -> bool:
        sender = self._control_sender
        try:
            if self.output_port is not None:
                result = self.output_port.publish_control(event)
            elif sender is not None:
                result = sender(event)
            else:
                raise RuntimeError("interaction_orchestrator_output_port_missing")
            if asyncio.iscoroutine(result) or isinstance(result, Awaitable):
                result = await result
            sent = result is not False
            if required and not sent:
                raise RuntimeError(f"control_event_send_failed:{event.type}")
            return sent
        except Exception:
            if required:
                raise
            return False

    async def emit_message_chain(self, *args: Any, **kwargs: Any) -> None:
        if self._segment_assembler is None:
            raise RuntimeError("interaction_orchestrator_segment_assembler_missing")
        await self._segment_assembler.emit_message_chain(*args, **kwargs)

    async def finalize_output_segment(self, **kwargs: Any) -> None:
        if self._segment_assembler is None:
            raise RuntimeError("interaction_orchestrator_segment_assembler_missing")
        await self._segment_assembler.finalize_output_segment(**kwargs)

    async def close_turn_output_queue(self, **kwargs: Any) -> None:
        if self._segment_assembler is None:
            raise RuntimeError("interaction_orchestrator_segment_assembler_missing")
        await self._segment_assembler.close_turn_output_queue(**kwargs)

    async def open_incremental_output(self, **kwargs: Any) -> Any:
        if self._segment_assembler is None:
            raise RuntimeError("interaction_orchestrator_segment_assembler_missing")
        return await self._segment_assembler.open_incremental_output(**kwargs)

    async def discard_incremental_output(self, **kwargs: Any) -> bool:
        if self._segment_assembler is None:
            raise RuntimeError("interaction_orchestrator_segment_assembler_missing")
        return await self._segment_assembler.discard_incremental_output(**kwargs)

    def has_pending_persona_segment(self, **kwargs: Any) -> bool:
        if self._segment_assembler is None:
            return False
        return self._segment_assembler.has_pending_persona_segment(**kwargs)

    async def interrupt(self, turn_id: str | None = None) -> None:
        self._require_started()
        await self.conversation_provider.interrupt(turn_id)

    async def close(self) -> None:
        if self._closed:
            return
        for unsubscribe in self._unsubscribers:
            unsubscribe()
        self._unsubscribers.clear()
        sink_tasks = tuple(self._sink_tasks)
        if sink_tasks:
            await asyncio.gather(*sink_tasks, return_exceptions=True)
        self._sink_tasks.clear()
        await self.conversation_provider.close()
        if self._conversation_event_assembler is not None:
            close_assembler = getattr(self._conversation_event_assembler, "close", None)
            if callable(close_assembler):
                await _await_handler(close_assembler())
        for provider in (
            self.stt_provider,
            self.tts_provider,
            self.motion_provider,
        ):
            close_provider = getattr(provider, "close", None)
            if callable(close_provider):
                result = close_provider()
                if asyncio.iscoroutine(result) or isinstance(result, Awaitable):
                    await result
        self.clear_lifecycle_state()
        self._started = False
        self._closed = True

    def clear_lifecycle_state(self) -> None:
        """Resolve pending waiters and discard connection-owned lifecycle facts."""

        for waiters in self.terminal_waiters.values():
            for waiter in waiters:
                if not waiter.done():
                    waiter.set_result(
                        (False, "interaction_orchestrator_reset_before_completion")
                    )
        self.terminal_waiters.clear()
        self.terminal_results.clear()
        self.terminating_turn_ids.clear()
        self.turn_timings.clear()
        self.active_events.clear()
        self._turns.clear()

    def register_active_event(self, turn_id: str, event: Any) -> None:
        normalized_turn_id = str(turn_id or "").strip()
        if normalized_turn_id:
            self.active_events[normalized_turn_id] = event

    def get_active_event(self, turn_id: str) -> Any | None:
        return self.active_events.get(str(turn_id or "").strip())

    def remove_active_event(self, turn_id: str) -> Any | None:
        return self.active_events.pop(str(turn_id or "").strip(), None)

    def clear_active_events(self) -> None:
        self.active_events.clear()

    def reset_active_events(self) -> list[str]:
        """Stop and clear active platform events through the injected owner."""

        failures: list[str] = []
        for turn_id, event in tuple(self.active_events.items()):
            try:
                if self._active_event_motion_cancel is not None:
                    self._active_event_motion_cancel(
                        event,
                        turn_id,
                        "transport_disconnected",
                    )
                set_extra = getattr(event, "set_extra", None)
                if callable(set_extra):
                    try:
                        set_extra("agent_stop_requested", True)
                    except Exception:
                        failures.append(f"{turn_id}:set_extra_failed")
                else:
                    failures.append(f"{turn_id}:set_extra_unavailable")
                stop_event = getattr(event, "stop_event", None)
                if callable(stop_event):
                    try:
                        stop_event()
                    except Exception:
                        failures.append(f"{turn_id}:stop_event_failed")
                else:
                    failures.append(f"{turn_id}:stop_event_unavailable")
            except Exception as exc:  # noqa: BLE001 - continue cleanup.
                failures.append(f"{turn_id}:active_event_cleanup_failed:{exc}")
        self.active_events.clear()
        return failures

    def begin_turn_timing(
        self,
        turn_id: str,
        user_text: str,
        turn_index: int,
    ) -> None:
        normalized_turn_id = str(turn_id or "").strip()
        if not normalized_turn_id:
            return
        self.turn_timings[normalized_turn_id] = {
            "turn_index": turn_index,
            "received_at": time.perf_counter(),
            "user_text_len": len(user_text or ""),
        }

    def mark_turn_timing(
        self,
        turn_id: str,
        key: str,
        value: float | None = None,
        *,
        turn_index: int = 0,
    ) -> None:
        timing = self.turn_timings.setdefault(
            str(turn_id or "").strip(),
            {"turn_index": turn_index},
        )
        timing[key] = time.perf_counter() if value is None else value

    def elapsed_turn_ms(self, turn_id: str, start_key: str, end_key: str) -> float:
        timing = self.turn_timings.get(str(turn_id or "").strip(), {})
        start_value = _coerce_perf_counter(timing.get(start_key))
        end_value = _coerce_perf_counter(timing.get(end_key))
        if start_value is None or end_value is None:
            return -1.0
        return max((end_value - start_value) * 1000.0, 0.0)

    async def wait_for_turn_finished(
        self,
        *,
        turn_id: str,
        timeout_seconds: float,
    ) -> tuple[bool, str | None]:
        """Wait on the terminal registry owned by this orchestrator."""

        normalized_turn_id = str(turn_id or "").strip()
        if not normalized_turn_id:
            raise ValueError("turn_id is required")
        if isinstance(timeout_seconds, bool) or timeout_seconds <= 0:
            raise ValueError("turn_finished_wait_timeout_invalid")
        terminal = self.terminal_results.get(normalized_turn_id)
        if terminal is not None:
            return terminal
        future = asyncio.get_running_loop().create_future()
        self.terminal_waiters.setdefault(normalized_turn_id, []).append(future)
        try:
            return await asyncio.wait_for(
                asyncio.shield(future), timeout=float(timeout_seconds)
            )
        except asyncio.TimeoutError as exc:
            raise TimeoutError(
                f"turn_finished_ack_timeout:{normalized_turn_id}"
            ) from exc
        finally:
            waiters = self.terminal_waiters.get(normalized_turn_id)
            if waiters is not None:
                if future in waiters:
                    waiters.remove(future)
                if not waiters:
                    self.terminal_waiters.pop(normalized_turn_id, None)
            if not future.done():
                future.cancel()

    def begin_turn_termination(self, turn_id: str) -> bool:
        normalized_turn_id = str(turn_id or "").strip()
        if not normalized_turn_id:
            return False
        if (
            normalized_turn_id in self.terminal_results
            or normalized_turn_id in self.terminating_turn_ids
        ):
            return False
        self.terminating_turn_ids.add(normalized_turn_id)
        return True

    def end_turn_termination(self, turn_id: str) -> None:
        self.terminating_turn_ids.discard(str(turn_id or "").strip())

    def begin_terminal_publication(
        self,
        turn_id: str,
        terminal_result: tuple[bool, str | None],
    ) -> tuple[bool, tuple[bool, str | None] | None]:
        normalized_turn_id = str(turn_id or "").strip()
        if normalized_turn_id in self.terminal_results:
            return False, self.terminal_results[normalized_turn_id]
        self.terminal_results[normalized_turn_id] = None
        return True, None

    def rollback_terminal_publication(
        self,
        turn_id: str,
        failure_reason: str,
    ) -> None:
        normalized_turn_id = str(turn_id or "").strip()
        self.terminal_results.pop(normalized_turn_id, None)
        for waiter in self.terminal_waiters.pop(normalized_turn_id, []):
            if not waiter.done():
                waiter.set_result((False, failure_reason))

    def commit_terminal_publication(
        self,
        turn_id: str,
        terminal_result: tuple[bool, str | None],
    ) -> None:
        normalized_turn_id = str(turn_id or "").strip()
        self.terminal_results[normalized_turn_id] = terminal_result
        for waiter in self.terminal_waiters.pop(normalized_turn_id, []):
            if not waiter.done():
                waiter.set_result(terminal_result)

    def prune_terminal_results(self, max_results: int = 256) -> None:
        completed = [
            turn_id
            for turn_id, result in self.terminal_results.items()
            if result is not None
        ]
        overflow = len(completed) - max_results
        for turn_id in completed[: max(0, overflow)]:
            self.terminal_results.pop(turn_id, None)

    def admit_turn(self, turn_id: str, user_text: str) -> None:
        """Record Turn admission without changing the existing Turn owner."""

        normalized_turn_id = str(turn_id or "").strip()
        if not normalized_turn_id:
            return
        state = self._turns.setdefault(normalized_turn_id, _TurnState(normalized_turn_id))
        state.admitted = True
        state.user_text = str(user_text or "")

    def discard_turn(self, turn_id: str) -> None:
        """Remove an admission that failed before an AstrBot event existed."""

        normalized_turn_id = str(turn_id or "").strip()
        self._turns.pop(normalized_turn_id, None)
        self.turn_timings.pop(normalized_turn_id, None)
        self.active_events.pop(normalized_turn_id, None)

    def register_segment(
        self,
        *,
        turn_id: str,
        message_id: str,
        sequence: int,
        published: bool,
    ) -> None:
        """Record a segment fact after the existing publisher has decided it."""

        normalized_turn_id = str(turn_id or "").strip()
        normalized_message_id = str(message_id or "").strip()
        if not normalized_turn_id or not normalized_message_id:
            return
        state = self._turns.setdefault(normalized_turn_id, _TurnState(normalized_turn_id))
        segment = state.segments.setdefault(
            normalized_message_id,
            _SegmentState(message_id=normalized_message_id),
        )
        segment.sequence = sequence if isinstance(sequence, int) else segment.sequence
        segment.published = bool(published)

    def complete_turn(self, turn_id: str, *, success: bool, reason: str | None) -> None:
        normalized_turn_id = str(turn_id or "").strip()
        if not normalized_turn_id:
            return
        state = self._turns.setdefault(normalized_turn_id, _TurnState(normalized_turn_id))
        state.terminal = (bool(success), str(reason).strip() if reason else None)
        self._prune_turn_snapshots()

    def snapshot_turn(self, turn_id: str) -> TurnSnapshot | None:
        state = self._turns.get(str(turn_id or "").strip())
        if state is None:
            return None
        return TurnSnapshot(
            turn_id=state.turn_id,
            user_text=state.user_text,
            admitted=state.admitted,
            terminal=state.terminal,
            segments=tuple(
                SegmentSnapshot(
                    message_id=segment.message_id,
                    sequence=segment.sequence,
                    published=segment.published,
                    tts_event=segment.tts_event,
                    motion_event=segment.motion_event,
                )
                for segment in state.segments.values()
            ),
        )

    def _require_started(self) -> None:
        if not self._started or self._closed:
            raise RuntimeError("interaction_orchestrator_not_started")

    def _route(self, source: str, value: object) -> asyncio.Future | None:
        self._record_provider_event(source, value)
        sink = self._event_sink
        event_assembler = (
            self._conversation_event_assembler
            if source == "conversation" and isinstance(value, ConversationEvent)
            else None
        )
        if sink is None and event_assembler is None:
            return None

        async def deliver() -> None:
            if event_assembler is not None:
                handle_event = getattr(event_assembler, "handle_event", None)
                if callable(handle_event):
                    await _await_handler(handle_event(value))
            if source == "execution" and isinstance(value, ExecutionEvent):
                publish_execution = getattr(self.output_port, "publish_execution", None)
                if callable(publish_execution):
                    await _await_handler(publish_execution(value))
            if sink is not None:
                result = sink(ProviderEvent(source=source, value=value))  # type: ignore[arg-type]
                await _await_handler(result)

        task = asyncio.create_task(deliver())
        self._sink_tasks.add(task)
        task.add_done_callback(self._sink_tasks.discard)
        task.add_done_callback(_consume_sink_task)
        return task

    def _prune_turn_snapshots(self, max_turns: int = 256) -> None:
        completed = [
            turn_id
            for turn_id, state in self._turns.items()
            if state.terminal is not None
        ]
        overflow = len(completed) - max_turns
        for turn_id in completed[: max(0, overflow)]:
            self._turns.pop(turn_id, None)

    def _record_provider_event(self, source: str, value: object) -> None:
        turn_id = str(getattr(value, "turn_id", "") or "").strip()
        if not turn_id:
            return
        state = self._turns.setdefault(turn_id, _TurnState(turn_id))
        if source == "conversation" and isinstance(value, ConversationEvent):
            if value.kind.value == "turn_started":
                state.admitted = True
            elif value.kind.value == "segment_boundary":
                boundary_message_id = str(
                    value.metadata.get("message_id")
                    if isinstance(value.metadata, Mapping)
                    else ""
                ).strip()
                boundary_message_id = boundary_message_id or (
                    value.boundary.provider_boundary_id
                    if value.boundary is not None
                    else ""
                )
                if boundary_message_id:
                    state.segments.setdefault(
                        boundary_message_id,
                        _SegmentState(message_id=boundary_message_id),
                    )
            elif value.kind.value == "turn_completed":
                state.terminal = (True, None)
            elif value.kind.value == "turn_failed":
                state.terminal = (False, value.reason)
            elif value.kind.value == "interrupted":
                state.terminal = (False, value.reason or "interrupted")
            return
        message_id = str(getattr(value, "message_id", "") or "").strip()
        if not message_id:
            return
        segment = state.segments.setdefault(
            message_id,
            _SegmentState(message_id=message_id),
        )
        if source == "tts" and isinstance(value, TtsLifecycleEvent):
            segment.tts_event = value
        elif source == "motion" and isinstance(value, MotionLifecycleEvent):
            segment.motion_event = value


@dataclass(slots=True)
class _SegmentState:
    message_id: str
    sequence: int | None = None
    published: bool = False
    tts_event: TtsLifecycleEvent | None = None
    motion_event: MotionLifecycleEvent | None = None


@dataclass(slots=True)
class _TurnState:
    turn_id: str
    user_text: str = ""
    admitted: bool = False
    terminal: tuple[bool, str | None] | None = None
    segments: dict[str, _SegmentState] = field(default_factory=dict)


def _consume_sink_task(task: asyncio.Task) -> None:
    if task.cancelled():
        return
    try:
        task.exception()
    except Exception:
        return


async def _await_handler(result: Any) -> None:
    if asyncio.iscoroutine(result) or isinstance(result, Awaitable):
        await result


def _terminal_payload(*, success: bool, reason: str | None) -> dict[str, Any]:
    payload: dict[str, Any] = {"success": bool(success)}
    if reason:
        payload["reason"] = reason
    return payload


def _coerce_perf_counter(value: Any) -> float | None:
    if isinstance(value, (int, float)):
        return float(value)
    return None


__all__ = [
    "InteractionOrchestrator",
    "FrontendMessageHandlers",
    "ProviderEvent",
    "ProviderEventSink",
    "SegmentSnapshot",
    "TurnSnapshot",
]
