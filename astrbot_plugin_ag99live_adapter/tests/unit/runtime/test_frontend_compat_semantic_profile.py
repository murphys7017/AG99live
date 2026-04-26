from __future__ import annotations

import asyncio
from types import SimpleNamespace

from astrbot_plugin_ag99live_adapter.live2d.semantic_axis_profile import SemanticAxisProfileError
from astrbot_plugin_ag99live_adapter.services.frontend_compat_service import FrontendCompatHandler


class _RuntimeStateStub:
    def __init__(self, *, error: Exception | None = None) -> None:
        self.error = error
        self.calls: list[dict[str, object]] = []

    def save_semantic_axis_profile_update(
        self,
        *,
        model_name: str,
        profile_payload: object,
        expected_revision: object,
    ) -> None:
        if self.error is not None:
            raise self.error
        self.calls.append(
            {
                "model_name": model_name,
                "profile_payload": profile_payload,
                "expected_revision": expected_revision,
            }
        )


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
                    "model_name": "DemoModel",
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
    assert sent_payloads == []
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
                    "model_name": "DemoModel",
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
    assert sent_payloads[0]["type"] == "control.error"
    assert sent_payloads[0]["payload"]["message"] == "broken profile"
