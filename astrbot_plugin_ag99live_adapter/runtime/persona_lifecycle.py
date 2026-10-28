"""Typed ownership for Persona turn, result, and segment lifecycle state."""

from __future__ import annotations

import asyncio
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

_MAX_RETIRED_TURN_IDS = 256


@dataclass(frozen=True, slots=True)
class PersonaTurnIdentity:
    turn_id: str
    core_turn_id: str | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.turn_id, str) or not self.turn_id.strip():
            raise ValueError("persona_turn_identity_invalid")
        if self.core_turn_id is not None and (
            not isinstance(self.core_turn_id, str) or not self.core_turn_id.strip()
        ):
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
        if not isinstance(self.turn, PersonaTurnIdentity):
            raise ValueError("persona_turn_identity_invalid")
        if not isinstance(self.persona_result_id, str) or not self.persona_result_id.strip():
            raise ValueError("persona_result_identity_invalid")
        if type(self.segment_index) is not int or self.segment_index < 0:
            raise ValueError("persona_segment_index_invalid")
        if self.segment_count is not None and (
            type(self.segment_count) is not int
            or self.segment_count <= self.segment_index
        ):
            raise ValueError("persona_segment_count_invalid")
        if self.segment_message_id is not None and (
            not isinstance(self.segment_message_id, str)
            or not self.segment_message_id.strip()
        ):
            raise ValueError("persona_segment_message_identity_invalid")
        if self.sequence is not None and (
            type(self.sequence) is not int or self.sequence < 0
        ):
            raise ValueError("persona_output_sequence_invalid")


@dataclass(frozen=True, slots=True)
class PersonaTtsBinding:
    identity: PersonaSegmentIdentity
    parent_message_id: str
    tts_request_id: str
    external_correlation_id: str | None = None
    speech: str = ""
    motion_payload: dict[str, Any] | None = None


@dataclass(slots=True)
class PersonaDeliveryAssemblyState:
    streaming: bool = False
    segment_indexes: set[int] = field(default_factory=set)
    template_extras: dict[str, Any] | None = None
    delivery_completed: bool = False

    def remember_segment(
        self,
        *,
        segment_index: int,
        segment_count: int | None,
        streaming: bool,
        template_extras: dict[str, Any] | None,
    ) -> None:
        if type(segment_index) is not int or segment_index < 0:
            raise ValueError("persona_segment_index_invalid")
        if type(streaming) is not bool:
            raise ValueError("persona_streaming_state_invalid")
        if segment_count is not None and (
            type(segment_count) is not int or segment_count <= segment_index
        ):
            raise ValueError("persona_segment_count_invalid")
        if self.delivery_completed:
            raise RuntimeError("persona_delivery_assembly_closed")
        if streaming and segment_index in self.segment_indexes:
            raise RuntimeError("persona_stream_segment_index_duplicate")
        if streaming and segment_index != len(self.segment_indexes):
            raise RuntimeError("persona_stream_segment_index_nonsequential")
        if segment_count is not None and segment_index >= segment_count:
            raise RuntimeError("persona_segment_index_out_of_range")
        self.streaming = self.streaming or streaming
        self.segment_indexes.add(segment_index)
        if template_extras is not None:
            self.template_extras = dict(template_extras)

    def validate_completion(self, *, segment_count: int, status: str) -> None:
        if type(segment_count) is not int or segment_count < 0:
            raise ValueError("persona_segment_count_invalid")
        if status not in {"completed", "incomplete", "failed", "cancelled"}:
            raise ValueError("persona_stream_terminal_status_invalid")
        indexes = self.segment_indexes
        if any(type(index) is not int or index < 0 or index >= segment_count for index in indexes):
            raise RuntimeError("persona_stream_segment_index_out_of_range")
        if status == "completed" and indexes != set(range(segment_count)):
            raise RuntimeError("persona_stream_segment_coverage_incomplete")
        if status != "completed" and indexes != set(range(len(indexes))):
            raise RuntimeError("persona_stream_segment_prefix_invalid")

    def close(self) -> None:
        self.segment_indexes.clear()
        self.template_extras = None
        self.delivery_completed = True


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
    preview_task: asyncio.Task[Any] | None = None
    tts_binding: PersonaTtsBinding | None = None

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
            segment_count=(
                segment_count
                if segment_count is not None
                else (
                    self.tts_binding.identity.segment_count
                    if self.tts_binding is not None
                    else None
                )
            ),
            segment_message_id=(
                self.tts_binding.identity.segment_message_id
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
    delivery_assembly: PersonaDeliveryAssemblyState | None = None

    def __post_init__(self) -> None:
        if not self.persona_result_id.strip():
            raise ValueError("persona_result_identity_invalid")

    def segment(self, identity: PersonaSegmentIdentity) -> PersonaSegmentState:
        if not isinstance(identity, PersonaSegmentIdentity):
            raise ValueError("persona_segment_identity_invalid")
        if (
            identity.turn.turn_id != self.turn.turn_id
            or (
                identity.turn.core_turn_id is not None
                and self.turn.core_turn_id is not None
                and identity.turn.core_turn_id != self.turn.core_turn_id
            )
            or identity.persona_result_id != self.persona_result_id
        ):
            raise ValueError("persona_segment_identity_conflict")
        if identity.segment_count is not None:
            self.set_expected_segment_count(identity.segment_count)
        if self.stream_status is not None and identity.segment_index not in self.segments:
            raise RuntimeError("persona_result_terminal_segment_unknown")
        segment = self.segments.setdefault(
            identity.segment_index,
            PersonaSegmentState(index=identity.segment_index),
        )
        if identity.segment_message_id is not None:
            if segment.segment_message_id not in {None, identity.segment_message_id}:
                raise ValueError("persona_segment_message_identity_conflict")
            segment.segment_message_id = identity.segment_message_id
        return segment

    def bind_intent(
        self,
        identity: PersonaSegmentIdentity,
        *,
        actions: Any,
        tendency: Any,
    ) -> PersonaSegmentState:
        if self.stream_status is not None:
            raise RuntimeError("persona_result_terminal")
        segment = self.segment(identity)
        segment.bind_intent(actions=actions, tendency=tendency)
        return segment

    def bind_content(
        self,
        identity: PersonaSegmentIdentity,
        *,
        speech: str,
        actions: Any,
        tendency: Any,
    ) -> PersonaSegmentState:
        if self.stream_status is not None:
            raise RuntimeError("persona_result_terminal")
        segment = self.segment(identity)
        segment.bind_content(speech=speech, actions=actions, tendency=tendency)
        return segment

    def bind_tts(self, binding: PersonaTtsBinding) -> PersonaSegmentState:
        if not isinstance(binding, PersonaTtsBinding):
            raise ValueError("persona_tts_binding_invalid")
        assembly = self.delivery_assembly
        if assembly is not None and assembly.delivery_completed:
            raise RuntimeError("persona_delivery_assembly_closed")
        segment = self.segment(binding.identity)
        if segment.tts_binding is not None and segment.tts_binding != binding:
            raise ValueError("persona_tts_binding_conflict")
        segment.tts_binding = binding
        return segment

    def set_expected_segment_count(self, segment_count: int) -> None:
        if type(segment_count) is not int or segment_count < 0:
            raise ValueError("persona_segment_count_invalid")
        if self.expected_segment_count not in {None, segment_count}:
            raise ValueError("persona_segment_count_conflict")
        self.expected_segment_count = segment_count

    def delivery_assembly_state(
        self, *, streaming: bool = False
    ) -> PersonaDeliveryAssemblyState:
        if type(streaming) is not bool:
            raise ValueError("persona_streaming_state_invalid")
        if self.delivery_assembly is None:
            self.delivery_assembly = PersonaDeliveryAssemblyState()
        self.delivery_assembly.streaming = self.delivery_assembly.streaming or streaming
        return self.delivery_assembly

    def remember_delivery_segment(
        self,
        *,
        segment_index: int,
        segment_count: int | None,
        streaming: bool,
        template_extras: dict[str, Any] | None,
    ) -> None:
        if self.stream_status is not None and segment_index not in self.segments:
            raise RuntimeError("persona_result_terminal_segment_unknown")
        if segment_count is not None:
            self.set_expected_segment_count(segment_count)
        assembly = self.delivery_assembly_state(streaming=streaming)
        assembly.remember_segment(
            segment_index=segment_index,
            segment_count=self.expected_segment_count,
            streaming=streaming,
            template_extras=template_extras,
        )

    def mark_delivery_completed(self) -> None:
        assembly = self.delivery_assembly
        if assembly is None:
            self.delivery_assembly = PersonaDeliveryAssemblyState(
                delivery_completed=True
            )
            return
        if assembly.delivery_completed:
            return
        assembly.delivery_completed = True
        if not assembly.streaming:
            assembly.close()
            return
        if self.stream_status is not None:
            if self.expected_segment_count is None:
                raise RuntimeError("persona_stream_segment_count_missing")
            assembly.validate_completion(
                segment_count=self.expected_segment_count,
                status=self.stream_status,
            )
            assembly.close()

    def set_parent_message_id(self, message_id: str) -> None:
        normalized = str(message_id or "").strip()
        if not normalized:
            raise ValueError("persona_parent_message_identity_invalid")
        if self.parent_message_id and self.parent_message_id != normalized:
            raise ValueError("persona_parent_message_identity_conflict")
        self.parent_message_id = normalized

    def finish_stream(self, status: str, failure_reason: str | None = None) -> None:
        normalized_status = str(status or "").strip().lower()
        if normalized_status not in {"completed", "incomplete", "failed", "cancelled"}:
            raise ValueError("persona_stream_terminal_status_invalid")
        if self.stream_status is not None:
            if self.stream_status != normalized_status:
                raise RuntimeError("persona_stream_terminal_conflict")
            if self.stream_failure_reason is None:
                self.stream_failure_reason = str(failure_reason or "").strip() or None
            return
        normalized_reason = str(failure_reason or "").strip() or None
        assembly = self.delivery_assembly
        if assembly is not None:
            assembly.streaming = True
            if assembly.delivery_completed:
                if self.expected_segment_count is None:
                    raise RuntimeError("persona_stream_segment_count_missing")
                assembly.validate_completion(
                    segment_count=self.expected_segment_count,
                    status=normalized_status,
                )
                assembly.close()
        self.stream_status = normalized_status
        self.stream_failure_reason = normalized_reason
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
            if segment.result_future is not None and not segment.result_future.done():
                segment.result_future.cancel()


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
    retired_result_ids: set[str] = field(default_factory=set)

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
        if self.cancelled:
            raise RuntimeError("persona_turn_cancelled")
        if normalized_id in self.retired_result_ids:
            raise RuntimeError("persona_result_retired")
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
        self._closed_turn_ids: dict[str, None] = {}

    def _remember_closed_turn(self, turn_id: str) -> None:
        self._closed_turn_ids.pop(turn_id, None)
        self._closed_turn_ids[turn_id] = None
        while len(self._closed_turn_ids) > _MAX_RETIRED_TURN_IDS:
            self._closed_turn_ids.pop(next(iter(self._closed_turn_ids)))

    @staticmethod
    def _require_turn_identity(identity: PersonaTurnIdentity) -> PersonaTurnIdentity:
        if not isinstance(identity, PersonaTurnIdentity):
            raise ValueError("persona_turn_identity_required")
        return identity

    def _find_session(
        self,
        identity: PersonaTurnIdentity,
    ) -> PersonaTurnSession | None:
        identity = self._require_turn_identity(identity)
        session = self._sessions.get(identity.turn_id)
        if (
            session is not None
            and identity.core_turn_id is not None
            and session.identity.core_turn_id not in {None, identity.core_turn_id}
        ):
            raise ValueError("persona_core_turn_identity_conflict")
        return session

    def session(self, identity: PersonaTurnIdentity) -> PersonaTurnSession:
        identity = self._require_turn_identity(identity)
        if identity.turn_id in self._closed_turn_ids:
            raise RuntimeError("persona_turn_retired")
        session = self._find_session(identity)
        normalized_turn_id = identity.turn_id
        if session is None:
            session = PersonaTurnSession(identity=identity)
            self._sessions[normalized_turn_id] = session
        elif identity.core_turn_id and session.identity.core_turn_id is None:
            session.identity = identity
            for result in session.results.values():
                result.turn = identity
        return session

    def get_result(
        self,
        identity: PersonaTurnIdentity,
        persona_result_id: str,
    ) -> PersonaResultState | None:
        session = self._find_session(identity)
        if session is None:
            return None
        return session.results.get(str(persona_result_id or "").strip())

    def get_active_result(
        self,
        identity: PersonaTurnIdentity,
    ) -> PersonaResultState | None:
        session = self.get_session(identity)
        if session is None or session.active_result_id is None:
            return None
        return session.results.get(session.active_result_id)

    def find_segment_by_message_id(
        self,
        identity: PersonaTurnIdentity,
        message_id: str,
    ) -> tuple[PersonaResultState, PersonaSegmentState] | None:
        session = self.get_session(identity)
        if session is None:
            return None
        normalized_message_id = str(message_id or "").strip()
        for result in session.results.values():
            for segment in result.segments.values():
                binding = segment.tts_binding
                if (
                    binding is not None
                    and binding.identity.segment_message_id == normalized_message_id
                ):
                    return result, segment
        return None

    def register_writer(
        self,
        identity: PersonaTurnIdentity,
        persona_result_id: str,
        writer: Any,
    ) -> PersonaResultState:
        identity = self._require_turn_identity(identity)
        normalized_result_id = str(persona_result_id or "").strip()
        if not normalized_result_id:
            raise ValueError("persona_result_identity_invalid")
        core_turn_id = str(getattr(writer, "core_turn_id", "") or "").strip()
        if (
            core_turn_id
            and identity.core_turn_id
            and identity.core_turn_id != core_turn_id
        ):
            raise ValueError("persona_core_turn_identity_conflict")
        if core_turn_id and not identity.core_turn_id:
            identity = PersonaTurnIdentity(identity.turn_id, core_turn_id)
        session = self.session(identity)
        result = session.result(normalized_result_id)
        if result.stream_status is not None:
            raise RuntimeError("persona_result_terminal")
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

    def get_session(
        self,
        identity: PersonaTurnIdentity,
    ) -> PersonaTurnSession | None:
        return self._find_session(identity)

    def register_task(
        self,
        identity: PersonaTurnIdentity,
        task: asyncio.Task[Any],
    ) -> bool:
        if not isinstance(task, asyncio.Task):
            return False
        try:
            session = self.session(identity)
        except RuntimeError:
            task.cancel()
            return False
        if session.cancelled:
            task.cancel()
            return False
        session.tasks.add(task)
        task.add_done_callback(session.tasks.discard)
        return True

    def register_result_task(
        self,
        identity: PersonaTurnIdentity,
        persona_result_id: str,
        task: asyncio.Task[Any],
    ) -> bool:
        if not isinstance(task, asyncio.Task):
            return False
        result = self.get_result(identity, persona_result_id)
        if (
            result is None
            or result.stream_status is not None
            or not self.register_task(identity, task)
        ):
            task.cancel()
            return False
        result.tasks.add(task)
        task.add_done_callback(result.tasks.discard)
        return True

    def clear_result(
        self,
        identity: PersonaTurnIdentity,
        persona_result_id: str,
    ) -> None:
        identity = self._require_turn_identity(identity)
        normalized_result_id = str(persona_result_id or "").strip()
        if not normalized_result_id:
            raise ValueError("persona_result_identity_invalid")
        session = self._find_session(identity)
        if session is None:
            return
        session.retired_result_ids.add(normalized_result_id)
        result = session.results.pop(normalized_result_id, None)
        if session.active_result_id == normalized_result_id:
            session.active_result_id = None
        if result is not None:
            result.cancel()

    def clear_turn(self, identity: PersonaTurnIdentity) -> None:
        identity = self._require_turn_identity(identity)
        session = self._find_session(identity)
        self._remember_closed_turn(identity.turn_id)
        if session is not None:
            self._sessions.pop(identity.turn_id, None)
        if session is not None:
            session.cancel()

    def reset(self) -> None:
        for session in tuple(self._sessions.values()):
            self.clear_turn(session.identity)
        self._closed_turn_ids.clear()
