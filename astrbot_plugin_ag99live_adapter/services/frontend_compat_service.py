from __future__ import annotations

from typing import Awaitable, Callable
from uuid import uuid4

from ..live2d.semantic_axis_profile import (
    SemanticAxisProfileError,
    SemanticAxisProfileRevisionError,
)
from ..protocol.builder import (
    build_control_error,
    build_system_background_list,
    build_system_heartbeat_ack,
    build_system_history_created,
    build_system_history_data,
    build_system_history_deleted,
    build_system_history_list,
    build_system_motion_tuning_samples_state,
    build_system_semantic_axis_profile_save_failed,
    build_system_semantic_axis_profile_saved,
)
from ..protocol import (
    TYPE_SYSTEM_BACKGROUND_LIST_REQUEST,
    TYPE_SYSTEM_HEARTBEAT,
    TYPE_SYSTEM_HISTORY_CREATE,
    TYPE_SYSTEM_HISTORY_DELETE,
    TYPE_SYSTEM_HISTORY_LIST_REQUEST,
    TYPE_SYSTEM_HISTORY_LOAD,
    TYPE_SYSTEM_MOTION_TUNING_SAMPLE_DELETE,
    TYPE_SYSTEM_MOTION_TUNING_SAMPLE_SAVE,
    TYPE_SYSTEM_SEMANTIC_AXIS_PROFILE_SAVE,
)

SUPPORTED_SYSTEM_MESSAGE_TYPES = {
    TYPE_SYSTEM_BACKGROUND_LIST_REQUEST,
    TYPE_SYSTEM_HISTORY_LIST_REQUEST,
    TYPE_SYSTEM_HISTORY_CREATE,
    TYPE_SYSTEM_HISTORY_LOAD,
    TYPE_SYSTEM_HISTORY_DELETE,
    TYPE_SYSTEM_HEARTBEAT,
    TYPE_SYSTEM_MOTION_TUNING_SAMPLE_SAVE,
    TYPE_SYSTEM_MOTION_TUNING_SAMPLE_DELETE,
    TYPE_SYSTEM_SEMANTIC_AXIS_PROFILE_SAVE,
}


class FrontendCompatHandler:
    def __init__(
        self,
        *,
        background_files_getter: Callable[[], list[str]],
        history_bridge,
        runtime_state,
    ) -> None:
        self._background_files_getter = background_files_getter
        self._history_bridge = history_bridge
        self._runtime_state = runtime_state
        self._history_uid = ""

    @staticmethod
    def can_handle(msg_type: str | None) -> bool:
        return msg_type in SUPPORTED_SYSTEM_MESSAGE_TYPES

    async def handle(
        self,
        message,
        *,
        send_json: Callable[[dict], Awaitable[bool]],
        refresh_and_send_model: Callable[..., Awaitable[None]],
    ) -> None:
        msg_type = message.type
        session_id = message.session_id
        payload = message.payload

        if msg_type == TYPE_SYSTEM_BACKGROUND_LIST_REQUEST:
            await send_json(
                build_system_background_list(
                    session_id=session_id,
                    files=self._background_files_getter(),
                )
            )
        elif msg_type == TYPE_SYSTEM_HISTORY_LIST_REQUEST:
            histories = await self._history_bridge.list_histories()
            known_history_uids = {
                str(item.get("uid") or "").strip()
                for item in histories
                if isinstance(item, dict)
            }
            if self._history_uid not in known_history_uids:
                self._history_uid = next(iter(known_history_uids), "")
            await send_json(
                build_system_history_list(
                    session_id=session_id,
                    histories=histories,
                )
            )
        elif msg_type == TYPE_SYSTEM_HISTORY_CREATE:
            history_uid = await self._history_bridge.create_history()
            self._history_uid = history_uid or str(uuid4())
            await send_json(
                build_system_history_created(
                    session_id=session_id,
                    history_uid=self._history_uid,
                )
            )
        elif msg_type == TYPE_SYSTEM_HISTORY_LOAD:
            history_uid = str(payload.get("history_uid") or "").strip()
            messages = await self._history_bridge.fetch_history(history_uid)
            if history_uid:
                self._history_uid = history_uid
            await send_json(
                build_system_history_data(
                    session_id=session_id,
                    messages=messages,
                )
            )
        elif msg_type == TYPE_SYSTEM_HISTORY_DELETE:
            history_uid = str(payload.get("history_uid") or "").strip()
            success = await self._history_bridge.delete_history(history_uid)
            if success and history_uid == self._history_uid:
                self._history_uid = ""
            await send_json(
                build_system_history_deleted(
                    session_id=session_id,
                    history_uid=history_uid,
                    success=success,
                )
            )
        elif msg_type == TYPE_SYSTEM_HEARTBEAT:
            await send_json(build_system_heartbeat_ack(session_id=session_id))
        elif msg_type == TYPE_SYSTEM_MOTION_TUNING_SAMPLE_SAVE:
            sample = payload.get("sample")
            self._runtime_state.save_motion_tuning_sample(sample)
            await send_json(
                build_system_motion_tuning_samples_state(
                    session_id=session_id,
                    turn_id=message.turn_id,
                    samples=self._runtime_state.list_motion_tuning_samples(),
                )
            )
        elif msg_type == TYPE_SYSTEM_MOTION_TUNING_SAMPLE_DELETE:
            sample_id = payload.get("sample_id")
            try:
                self._runtime_state.delete_motion_tuning_sample(sample_id)
            except ValueError as exc:
                await send_json(
                    build_control_error(
                        session_id=session_id,
                        turn_id=message.turn_id,
                        message=str(exc),
                    )
                )
                return
            await send_json(
                build_system_motion_tuning_samples_state(
                    session_id=session_id,
                    turn_id=message.turn_id,
                    samples=self._runtime_state.list_motion_tuning_samples(),
                )
            )
        elif msg_type == TYPE_SYSTEM_SEMANTIC_AXIS_PROFILE_SAVE:
            request_id = str(payload.get("request_id") or "").strip()
            model_name = str(payload.get("model_name") or "").strip()
            profile_id = str(payload.get("profile_id") or "").strip()
            expected_revision = payload.get("expected_revision")
            try:
                saved_profile = self._runtime_state.save_semantic_axis_profile_update(
                    model_name=model_name,
                    profile_payload=payload.get("profile"),
                    expected_revision=expected_revision,
                )
            except (FileNotFoundError, SemanticAxisProfileError, SemanticAxisProfileRevisionError) as exc:
                error_code = _semantic_profile_error_code(exc)
                await send_json(
                    build_system_semantic_axis_profile_save_failed(
                        session_id=session_id,
                        turn_id=message.turn_id,
                        request_id=request_id,
                        model_name=model_name,
                        profile_id=profile_id,
                        expected_revision=expected_revision if isinstance(expected_revision, int) else None,
                        error_code=error_code,
                        message=str(exc),
                    )
                )
                return
            await send_json(
                build_system_semantic_axis_profile_saved(
                    session_id=session_id,
                    turn_id=message.turn_id,
                    request_id=request_id,
                    model_name=model_name,
                    profile_id=str(saved_profile.get("profile_id") or profile_id),
                    revision=int(saved_profile.get("revision") or 0),
                    source_hash=str(saved_profile.get("source_hash") or ""),
                    saved_at=str(saved_profile.get("updated_at") or ""),
                )
            )
            await refresh_and_send_model(force=True)


def _semantic_profile_error_code(exc: Exception) -> str:
    if isinstance(exc, SemanticAxisProfileRevisionError):
        message = str(exc).lower()
        if "source_hash" in message:
            return "source_hash_conflict"
        if "revision" in message:
            return "revision_conflict"
        return "profile_revision_error"
    if isinstance(exc, FileNotFoundError):
        return "profile_not_found"
    return "profile_validation_error"
