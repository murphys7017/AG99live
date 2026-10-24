"""Typed ownership for Persona turn, result, and segment lifecycle state."""

from __future__ import annotations

import asyncio
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True, slots=True)
class PersonaTurnIdentity:
    turn_id: str
    core_turn_id: str | None = None

    def __post_init__(self) -> None:
        if not self.turn_id.strip():
            raise ValueError("persona_turn_identity_invalid")
        if self.core_turn_id is not None and not self.core_turn_id.strip():
            raise ValueError("persona_core_turn_identity_invalid")


@dataclass(frozen=True, slots=True)
class PersonaSegmentIdentity:
    turn: PersonaTurnIdentity
    persona_result_id: str
    segment_index: int
    segment_count: int | None = None
    segment_message_id: str | None = None
    sequence: int | None = None

    def __post_init__(self) -> None:
        if not self.persona_result_id.strip():
            raise ValueError("persona_result_identity_invalid")
        if type(self.segment_index) is not int or self.segment_index < 0:
            raise ValueError("persona_segment_index_invalid")
        if self.segment_count is not None and (
            type(self.segment_count) is not int
            or self.segment_count <= self.segment_index
        ):
            raise ValueError("persona_segment_count_invalid")
        if self.segment_message_id is not None and not self.segment_message_id.strip():
            raise ValueError("persona_segment_message_identity_invalid")
        if self.sequence is not None and (
            type(self.sequence) is not int or self.sequence < 0
        ):
            raise ValueError("persona_output_sequence_invalid")


@dataclass(frozen=True, slots=True)
class PersonaTtsBinding:
    turn_id: str
    parent_message_id: str
    persona_result_id: str
    segment_index: int
    segment_count: int
    message_id: str
    tts_request_id: str
    external_correlation_id: str | None = None
    speech: str = ""
    motion_payload: dict[str, Any] | None = None


@dataclass(slots=True)
class PersonaSegmentState:
    index: int
    segment_message_id: str | None = None
    speech: str | None = None
    speech_ready: bool = False
    intent_ready: bool = False
    actions: tuple[Any, ...] = ()
    tendency: dict[str, Any] = field(default_factory=dict)
    result_future: asyncio.Future[Any] | None = None
    deadline: float | None = None
    provider_result: Any = None
    preview_task: asyncio.Task[Any] | None = None
    tts_binding: PersonaTtsBinding | None = None
    pending_motion: tuple[dict[str, Any] | None, str, bool] | None = None
    wire_started: bool = False
    wire_motion_payload: dict[str, Any] | None = None
    wire_motion_revision: int = 0
    wire_motion_closed: bool = False
    wire_status: str = "not_started"
    wire_future: asyncio.Future[Any] | None = None
    cancelled: bool = False

    def bind_intent(self, *, actions: Any, tendency: Any) -> None:
        normalized_actions = tuple(actions) if isinstance(actions, (list, tuple)) else ()
        normalized_tendency = dict(tendency) if isinstance(tendency, Mapping) else {}
        if self.intent_ready and (
            self.actions != normalized_actions
            or self.tendency != normalized_tendency
        ):
            raise ValueError("persona_segment_intent_conflict")
        self.actions = normalized_actions
        self.tendency = normalized_tendency
        self.intent_ready = True

    def mark_wire_started(self, message_id: str) -> None:
        normalized = str(message_id or "").strip()
        if not normalized:
            raise ValueError("persona_segment_message_identity_invalid")
        if self.segment_message_id not in {None, normalized}:
            raise ValueError("persona_segment_message_identity_conflict")
        self.segment_message_id = normalized
        self.wire_started = True
        self.wire_status = "open"

    def bind_content(
        self,
        *,
        speech: str,
        actions: Any,
        tendency: Any,
    ) -> None:
        normalized_actions = tuple(actions) if isinstance(actions, (list, tuple)) else ()
        normalized_tendency = dict(tendency) if isinstance(tendency, Mapping) else {}
        if self.speech_ready and self.speech != speech:
            raise ValueError("persona_segment_content_conflict")
        if self.intent_ready and (
            self.actions != normalized_actions or self.tendency != normalized_tendency
        ):
            raise ValueError("persona_segment_content_conflict")
        self.speech = speech
        self.actions = normalized_actions
        self.tendency = normalized_tendency
        self.speech_ready = True

    def identity(
        self,
        result: PersonaResultState,
        *,
        segment_count: int | None = None,
        sequence: int | None = None,
    ) -> PersonaSegmentIdentity:
        return PersonaSegmentIdentity(
            turn=result.turn,
            persona_result_id=result.persona_result_id,
            segment_index=self.index,
            segment_count=segment_count,
            segment_message_id=(
                self.tts_binding.message_id
                if self.tts_binding is not None
                else self.segment_message_id
            ),
            sequence=sequence,
        )


@dataclass(slots=True)
class PersonaResultState:
    turn: PersonaTurnIdentity
    persona_result_id: str
    phase: str = ""
    parent_message_id: str = ""
    delivery_mode: str | None = None
    writer: Any = None
    segments: dict[int, PersonaSegmentState] = field(default_factory=dict)
    tasks: set[asyncio.Task[Any]] = field(default_factory=set)
    context_task: asyncio.Task[Any] | None = None
    concurrency_gate: asyncio.Semaphore | None = None
    parallel: bool = False
    next_segment_index: int = 0
    generation_task: asyncio.Task[Any] | None = None
    expected_segment_count: int | None = None
    stream_status: str | None = None
    stream_failure_reason: str | None = None
    view: Any = None
    delivery_state: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not self.persona_result_id.strip():
            raise ValueError("persona_result_identity_invalid")

    def segment(self, index: int) -> PersonaSegmentState:
        if type(index) is not int or index < 0:
            raise ValueError("persona_segment_index_invalid")
        return self.segments.setdefault(index, PersonaSegmentState(index=index))

    def set_parent_message_id(self, message_id: str) -> None:
        normalized = str(message_id or "").strip()
        if not normalized:
            raise ValueError("persona_parent_message_identity_invalid")
        if self.parent_message_id and self.parent_message_id != normalized:
            raise ValueError("persona_parent_message_identity_conflict")
        self.parent_message_id = normalized

    def finish_stream(self, status: str, failure_reason: str | None = None) -> None:
        self.stream_status = str(status or "").strip() or "failed"
        self.stream_failure_reason = str(failure_reason or "").strip() or None
        for task in tuple(self.tasks):
            if not task.done():
                task.cancel()
        if self.context_task is not None and not self.context_task.done():
            self.context_task.cancel()
        for segment in self.segments.values():
            if segment.result_future is not None and not segment.result_future.done():
                segment.result_future.cancel()

    def cancel(self) -> None:
        for task in tuple(self.tasks):
            if not task.done():
                task.cancel()
        if self.context_task is not None and not self.context_task.done():
            self.context_task.cancel()
        for segment in self.segments.values():
            segment.cancelled = True
            if segment.result_future is not None and not segment.result_future.done():
                segment.result_future.cancel()
            if segment.wire_future is not None and not segment.wire_future.done():
                segment.wire_future.cancel()


@dataclass(slots=True)
class PersonaTurnSession:
    identity: PersonaTurnIdentity
    results: dict[str, PersonaResultState] = field(default_factory=dict)
    tasks: set[asyncio.Task[Any]] = field(default_factory=set)
    message_children: dict[str, list[str]] = field(default_factory=dict)
    active_delivery_parent: str | None = None
    output_failure_reason: str | None = None
    active_result_id: str | None = None
    cancelled: bool = False

    def result(
        self,
        persona_result_id: str,
        *,
        phase: str = "",
        parent_message_id: str = "",
        parallel: bool = False,
        max_concurrency: int = 1,
    ) -> PersonaResultState:
        normalized_id = str(persona_result_id or "").strip()
        if not normalized_id:
            raise ValueError("persona_result_identity_invalid")
        result = self.results.get(normalized_id)
        if result is None:
            result = PersonaResultState(
                turn=self.identity,
                persona_result_id=normalized_id,
                phase=str(phase or "").strip(),
                parallel=parallel,
                concurrency_gate=asyncio.Semaphore(
                    max(1, max_concurrency if parallel else 1)
                ),
            )
            self.results[normalized_id] = result
        elif phase and result.phase and result.phase != phase:
            raise ValueError("persona_result_phase_conflict")
        elif phase and not result.phase:
            result.phase = phase
        if not result.segments and not result.tasks:
            result.parallel = parallel
            result.concurrency_gate = asyncio.Semaphore(
                max(1, max_concurrency if parallel else 1)
            )
        if parent_message_id:
            result.set_parent_message_id(parent_message_id)
        return result

    def cancel(self) -> None:
        self.cancelled = True
        for result in self.results.values():
            result.cancel()
        for task in tuple(self.tasks):
            if not task.done():
                task.cancel()

    def register_message_child(self, parent_id: str, message_id: str) -> None:
        children = self.message_children.setdefault(parent_id, [])
        if message_id not in children:
            children.append(message_id)

    def pop_message_children(self, parent_id: str) -> list[str]:
        return self.message_children.pop(parent_id, [parent_id])


class PersonaTurnSessionRegistry:
    """Single owner for Persona lifecycle state and Turn-scoped cancellation."""

    def __init__(self) -> None:
        self._sessions: dict[str, PersonaTurnSession] = {}

    def session(
        self,
        turn_id: str,
        *,
        core_turn_id: str | None = None,
    ) -> PersonaTurnSession:
        normalized_turn_id = str(turn_id or "").strip()
        if not normalized_turn_id:
            raise ValueError("persona_turn_identity_invalid")
        identity = PersonaTurnIdentity(normalized_turn_id, core_turn_id)
        session = self._sessions.get(normalized_turn_id)
        if session is None:
            session = PersonaTurnSession(identity=identity)
            self._sessions[normalized_turn_id] = session
        elif core_turn_id and session.identity.core_turn_id not in {None, core_turn_id}:
            raise ValueError("persona_core_turn_identity_conflict")
        elif core_turn_id and session.identity.core_turn_id is None:
            session.identity = identity
            for result in session.results.values():
                result.turn = identity
        return session

    def get_result(
        self,
        turn_id: str,
        persona_result_id: str,
    ) -> PersonaResultState | None:
        session = self._sessions.get(str(turn_id or "").strip())
        if session is None:
            return None
        return session.results.get(str(persona_result_id or "").strip())

    def get_active_result(self, turn_id: str) -> PersonaResultState | None:
        session = self.get_session(turn_id)
        if session is None or session.active_result_id is None:
            return None
        return session.results.get(session.active_result_id)

    def find_segment_by_message_id(
        self,
        turn_id: str,
        message_id: str,
    ) -> tuple[PersonaResultState, PersonaSegmentState] | None:
        session = self.get_session(turn_id)
        if session is None:
            return None
        normalized_message_id = str(message_id or "").strip()
        for result in session.results.values():
            for segment in result.segments.values():
                binding = segment.tts_binding
                if binding is not None and binding.message_id == normalized_message_id:
                    return result, segment
        return None

    def register_writer(
        self,
        turn_id: str,
        persona_result_id: str,
        writer: Any,
    ) -> PersonaResultState:
        normalized_result_id = str(persona_result_id or "").strip()
        if not normalized_result_id:
            raise ValueError("persona_result_identity_invalid")
        core_turn_id = str(getattr(writer, "core_turn_id", "") or "").strip()
        result = self.session(
            turn_id,
            core_turn_id=core_turn_id or None,
        ).result(normalized_result_id)
        session = self.session(turn_id)
        if session.active_result_id not in {None, normalized_result_id}:
            active_result = session.results.get(session.active_result_id)
            if active_result is None or active_result.stream_status is None:
                raise RuntimeError("persona_incremental_writer_already_active")
        if result.writer is not None and result.writer is not writer:
            raise RuntimeError("persona_incremental_writer_conflict")
        result.writer = writer
        result.delivery_mode = "M2_olv_incremental"
        session.active_result_id = normalized_result_id
        return result

    def get_session(self, turn_id: str) -> PersonaTurnSession | None:
        return self._sessions.get(str(turn_id or "").strip())

    def register_task(self, turn_id: str, task: asyncio.Task[Any]) -> bool:
        if not isinstance(task, asyncio.Task):
            return False
        session = self.session(turn_id)
        if session.cancelled:
            task.cancel()
            return False
        session.tasks.add(task)
        task.add_done_callback(session.tasks.discard)
        return True

    def register_result_task(
        self,
        turn_id: str,
        persona_result_id: str,
        task: asyncio.Task[Any],
    ) -> bool:
        result = self.get_result(turn_id, persona_result_id)
        if result is None or not self.register_task(turn_id, task):
            return False
        result.tasks.add(task)
        task.add_done_callback(result.tasks.discard)
        return True

    def clear_result(self, turn_id: str, persona_result_id: str) -> None:
        normalized_turn_id = str(turn_id or "").strip()
        session = self._sessions.get(normalized_turn_id)
        if session is None:
            return
        result = session.results.pop(str(persona_result_id or "").strip(), None)
        if session.active_result_id == str(persona_result_id or "").strip():
            session.active_result_id = None
        if result is not None:
            result.cancel()
        if not session.results and not session.tasks:
            self._sessions.pop(normalized_turn_id, None)

    def clear_turn(self, turn_id: str) -> None:
        session = self._sessions.pop(str(turn_id or "").strip(), None)
        if session is not None:
            session.cancel()

    def reset(self) -> None:
        for turn_id in tuple(self._sessions):
            self.clear_turn(turn_id)
