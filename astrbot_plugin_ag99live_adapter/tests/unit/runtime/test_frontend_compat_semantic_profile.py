from __future__ import annotations

import asyncio
from types import SimpleNamespace

from astrbot_plugin_ag99live_adapter.live2d.semantic_axis_profile import SemanticAxisProfileError
from astrbot_plugin_ag99live_adapter.services.frontend_compat_service import FrontendCompatHandler


class _RuntimeStateStub:
    def __init__(self, *, error: Exception | None = None) -> None:
        self.error = error
        self.calls: list[dict[str, object]] = []
        self.saved_motion_tuning_sample: object = None
        self.deleted_motion_tuning_sample_id: object = None
        self.motion_tuning_samples: list[dict[str, object]] = []

    def save_semantic_axis_profile_update(
        self,
        *,
        model_name: str,
        profile_payload: object,
        expected_revision: object,
    ) -> dict[str, object]:
        if self.error is not None:
            raise self.error
        self.calls.append(
            {
                "model_name": model_name,
                "profile_payload": profile_payload,
                "expected_revision": expected_revision,
            }
        )
        return {
            "model_id": model_name,
            "profile_id": f"{model_name}.semantic.v1",
            "revision": 4,
            "source_hash": "hash",
            "updated_at": "2026-04-26T00:00:00+00:00",
        }

    def save_motion_tuning_sample(self, sample: object) -> dict[str, object]:
        self.saved_motion_tuning_sample = sample
        if isinstance(sample, dict):
            self.motion_tuning_samples = [sample]
        return sample if isinstance(sample, dict) else {}

    def delete_motion_tuning_sample(self, sample_id: object) -> bool:
        self.deleted_motion_tuning_sample_id = sample_id
        if not any(item.get("id") == sample_id for item in self.motion_tuning_samples):
            raise ValueError(f"motion_tuning_sample_not_found: {sample_id}")
        self.motion_tuning_samples = []
        return True

    def list_motion_tuning_samples(self) -> list[dict[str, object]]:
        return list(self.motion_tuning_samples)


class _HistoryBridgeStub:
    async def list_histories(self) -> list[dict]:
        return []

    async def create_history(self) -> str:
        return "history"

    async def fetch_history(self, history_uid: str) -> list[dict]:
        return [{"history_uid": history_uid}]

    async def delete_history(self, history_uid: str) -> bool:
        return True


def test_frontend_compat_handler_saves_semantic_profile_and_refreshes() -> None:
    runtime_state = _RuntimeStateStub()
    handler = FrontendCompatHandler(
        background_files_getter=lambda: [],
        history_bridge=_HistoryBridgeStub(),
        runtime_state=runtime_state,
    )
    sent_payloads: list[dict] = []
    refresh_calls: list[bool] = []

    async def send_json(payload: dict) -> bool:
        sent_payloads.append(payload)
        return True

    async def refresh_and_send_model(*, force: bool = False) -> None:
        refresh_calls.append(force)

    asyncio.run(
        handler.handle(
            SimpleNamespace(
                type="system.semantic_axis_profile_save",
                session_id="session",
                turn_id="turn",
                payload={
                    "request_id": "request-1",
                    "model_name": "DemoModel",
                    "profile_id": "DemoModel.semantic.v1",
                    "expected_revision": 3,
                    "profile": {"schema_version": "ag99.semantic_axis_profile.v1"},
                },
            ),
            send_json=send_json,
            refresh_and_send_model=refresh_and_send_model,
        )
    )

    assert runtime_state.calls == [
        {
            "model_name": "DemoModel",
            "profile_payload": {"schema_version": "ag99.semantic_axis_profile.v1"},
            "expected_revision": 3,
        }
    ]
    assert len(sent_payloads) == 1
    assert sent_payloads[0]["type"] == "system.semantic_axis_profile_saved"
    assert sent_payloads[0]["payload"] == {
        "request_id": "request-1",
        "model_name": "DemoModel",
        "profile_id": "DemoModel.semantic.v1",
        "revision": 4,
        "source_hash": "hash",
        "saved_at": "2026-04-26T00:00:00+00:00",
    }
    assert refresh_calls == [True]


def test_frontend_compat_handler_returns_control_error_on_save_failure() -> None:
    runtime_state = _RuntimeStateStub(error=SemanticAxisProfileError("broken profile"))
    handler = FrontendCompatHandler(
        background_files_getter=lambda: [],
        history_bridge=_HistoryBridgeStub(),
        runtime_state=runtime_state,
    )
    sent_payloads: list[dict] = []
    refresh_calls: list[bool] = []

    async def send_json(payload: dict) -> bool:
        sent_payloads.append(payload)
        return True

    async def refresh_and_send_model(*, force: bool = False) -> None:
        refresh_calls.append(force)

    asyncio.run(
        handler.handle(
            SimpleNamespace(
                type="system.semantic_axis_profile_save",
                session_id="session",
                turn_id="turn",
                payload={
                    "request_id": "request-2",
                    "model_name": "DemoModel",
                    "profile_id": "DemoModel.semantic.v1",
                    "expected_revision": 1,
                    "profile": {"schema_version": "ag99.semantic_axis_profile.v1"},
                },
            ),
            send_json=send_json,
            refresh_and_send_model=refresh_and_send_model,
        )
    )

    assert refresh_calls == []
    assert len(sent_payloads) == 1
    assert sent_payloads[0]["type"] == "system.semantic_axis_profile_save_failed"
    assert sent_payloads[0]["payload"]["request_id"] == "request-2"
    assert sent_payloads[0]["payload"]["error_code"] == "profile_validation_error"
    assert sent_payloads[0]["payload"]["message"] == "broken profile"


def test_frontend_compat_handler_returns_control_error_on_missing_profile_file() -> None:
    runtime_state = _RuntimeStateStub(error=FileNotFoundError("profile missing"))
    handler = FrontendCompatHandler(
        background_files_getter=lambda: [],
        history_bridge=_HistoryBridgeStub(),
        runtime_state=runtime_state,
    )
    sent_payloads: list[dict] = []
    refresh_calls: list[bool] = []

    async def send_json(payload: dict) -> bool:
        sent_payloads.append(payload)
        return True

    async def refresh_and_send_model(*, force: bool = False) -> None:
        refresh_calls.append(force)

    asyncio.run(
        handler.handle(
            SimpleNamespace(
                type="system.semantic_axis_profile_save",
                session_id="session",
                turn_id="turn",
                payload={
                    "request_id": "request-3",
                    "model_name": "DemoModel",
                    "profile_id": "DemoModel.semantic.v1",
                    "expected_revision": 1,
                    "profile": {"schema_version": "ag99.semantic_axis_profile.v1"},
                },
            ),
            send_json=send_json,
            refresh_and_send_model=refresh_and_send_model,
        )
    )

    assert refresh_calls == []
    assert len(sent_payloads) == 1
    assert sent_payloads[0]["type"] == "system.semantic_axis_profile_save_failed"
    assert sent_payloads[0]["payload"]["request_id"] == "request-3"
    assert sent_payloads[0]["payload"]["error_code"] == "profile_not_found"
    assert sent_payloads[0]["payload"]["message"] == "profile missing"


def test_frontend_compat_handler_saves_motion_tuning_sample_and_pushes_state() -> None:
    runtime_state = _RuntimeStateStub()
    handler = FrontendCompatHandler(
        background_files_getter=lambda: [],
        history_bridge=_HistoryBridgeStub(),
        runtime_state=runtime_state,
    )
    sent_payloads: list[dict] = []

    sample = {
        "id": "sample-1",
        "created_at": "2026-04-29T00:00:00+00:00",
        "source_record_id": "record-1",
        "model_name": "DemoModel",
        "profile_id": "DemoModel.semantic.v1",
        "profile_revision": 3,
        "emotion_label": "joy",
        "assistant_text": "好的",
        "feedback": "嘴角再明显一点",
        "tags": ["smile"],
        "enabled_for_llm_reference": True,
        "original_axes": {"mouth_smile": 0.6},
        "adjusted_axes": {"mouth_smile": 0.8},
        "adjusted_plan": {
            "schema_version": "engine.parameter_plan.v2",
            "profile_id": "DemoModel.semantic.v1",
            "profile_revision": 3,
            "model_id": "DemoModel",
            "mode": "expressive",
            "emotion_label": "joy",
            "timing": {
                "duration_ms": 1200,
                "blend_in_ms": 120,
                "hold_ms": 800,
                "blend_out_ms": 280,
            },
            "parameters": [
                {
                    "axis_id": "mouth_smile",
                    "parameter_id": "ParamMouthSmile",
                    "target_value": 0.8,
                    "weight": 1.0,
                    "input_value": 0.8,
                    "source": "manual",
                }
            ],
        },
    }

    async def send_json(payload: dict) -> bool:
        sent_payloads.append(payload)
        return True

    async def refresh_and_send_model(*, force: bool = False) -> None:
        raise AssertionError("should not refresh model sync for motion tuning sample save")

    asyncio.run(
        handler.handle(
            SimpleNamespace(
                type="system.motion_tuning_sample_save",
                session_id="session",
                turn_id="turn",
                payload={"sample": sample},
            ),
            send_json=send_json,
            refresh_and_send_model=refresh_and_send_model,
        )
    )

    assert runtime_state.saved_motion_tuning_sample == sample
    assert len(sent_payloads) == 1
    assert sent_payloads[0]["type"] == "system.motion_tuning_samples_state"
    assert sent_payloads[0]["payload"]["samples"] == [sample]


def test_frontend_compat_handler_deletes_motion_tuning_sample_and_pushes_state() -> None:
    runtime_state = _RuntimeStateStub()
    runtime_state.motion_tuning_samples = [{"id": "sample-1"}]
    handler = FrontendCompatHandler(
        background_files_getter=lambda: [],
        history_bridge=_HistoryBridgeStub(),
        runtime_state=runtime_state,
    )
    sent_payloads: list[dict] = []

    async def send_json(payload: dict) -> bool:
        sent_payloads.append(payload)
        return True

    async def refresh_and_send_model(*, force: bool = False) -> None:
        raise AssertionError("should not refresh model sync for motion tuning sample delete")

    asyncio.run(
        handler.handle(
            SimpleNamespace(
                type="system.motion_tuning_sample_delete",
                session_id="session",
                turn_id=None,
                payload={"sample_id": "sample-1"},
            ),
            send_json=send_json,
            refresh_and_send_model=refresh_and_send_model,
        )
    )

    assert runtime_state.deleted_motion_tuning_sample_id == "sample-1"
    assert len(sent_payloads) == 1
    assert sent_payloads[0]["type"] == "system.motion_tuning_samples_state"
    assert sent_payloads[0]["payload"]["samples"] == []


def test_frontend_compat_handler_delete_missing_motion_tuning_sample_fails() -> None:
    runtime_state = _RuntimeStateStub()
    handler = FrontendCompatHandler(
        background_files_getter=lambda: [],
        history_bridge=_HistoryBridgeStub(),
        runtime_state=runtime_state,
    )
    sent_payloads: list[dict] = []

    async def send_json(payload: dict) -> bool:
        sent_payloads.append(payload)
        return True

    async def refresh_and_send_model(*, force: bool = False) -> None:
        raise AssertionError("should not refresh model sync for motion tuning sample delete")

    asyncio.run(
        handler.handle(
            SimpleNamespace(
                type="system.motion_tuning_sample_delete",
                session_id="session",
                turn_id="turn-delete-missing",
                payload={"sample_id": "missing-sample"},
            ),
            send_json=send_json,
            refresh_and_send_model=refresh_and_send_model,
        )
    )

    assert runtime_state.deleted_motion_tuning_sample_id == "missing-sample"
    assert len(sent_payloads) == 1
    assert sent_payloads[0]["type"] == "control.error"
    assert sent_payloads[0]["turn_id"] == "turn-delete-missing"
    assert sent_payloads[0]["payload"]["message"] == "motion_tuning_sample_not_found: missing-sample"
