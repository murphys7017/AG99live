from __future__ import annotations

import asyncio

import pytest

from astrbot_plugin_ag99live_adapter.runtime import desktop_settings_broker
from astrbot_plugin_ag99live_adapter.runtime.desktop_settings_broker import (
    DesktopSettingsBroker,
    DesktopSettingsError,
)


def test_queued_esp32_set_expires_before_it_is_sent(monkeypatch) -> None:
    async def run() -> None:
        monkeypatch.setattr(
            desktop_settings_broker,
            "DESKTOP_SETTINGS_MIN_ESP32_SET_BUDGET_SECONDS",
            0.09,
        )
        sent: list[dict] = []
        first_sent = asyncio.Event()

        async def send_json(payload: dict) -> bool:
            sent.append(payload)
            first_sent.set()
            return True

        broker = DesktopSettingsBroker(
            send_json=send_json,
            is_connected=lambda: True,
            timeout_seconds=0.1,
        )
        first = asyncio.create_task(
            broker.query(key="esp32_display_host", action="set", value="first")
        )
        await first_sent.wait()
        await asyncio.sleep(0.05)
        second = asyncio.create_task(
            broker.query(key="esp32_display_port", action="set", value="1234")
        )

        results = await asyncio.gather(first, second, return_exceptions=True)
        assert all(isinstance(result, DesktopSettingsError) for result in results)
        assert len(sent) == 1

    asyncio.run(run())


def test_esp32_set_response_budget_starts_after_send(monkeypatch) -> None:
    async def run() -> None:
        monkeypatch.setattr(
            desktop_settings_broker,
            "DESKTOP_SETTINGS_MIN_ESP32_SET_BUDGET_SECONDS",
            0.05,
        )
        sent: list[dict] = []
        broker: DesktopSettingsBroker

        async def send_json(payload: dict) -> bool:
            sent.append(payload)
            await asyncio.sleep(0.12)
            asyncio.get_running_loop().call_later(
                0.04,
                broker.resolve,
                {
                    "request_id": payload["payload"]["request_id"],
                    "ok": True,
                    "value": "1234",
                    "options": [],
                },
            )
            return True

        broker = DesktopSettingsBroker(
            send_json=send_json,
            is_connected=lambda: True,
            timeout_seconds=0.15,
        )
        result = await broker.query(
            key="esp32_display_port",
            action="set",
            value="1234",
        )
        assert result["value"] == "1234"
        assert len(sent) == 1

    asyncio.run(run())
