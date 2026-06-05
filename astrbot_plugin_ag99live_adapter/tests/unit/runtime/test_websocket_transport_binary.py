from __future__ import annotations

import asyncio


def test_websocket_transport_routes_binary_payload_to_binary_handler(install_fake_astrbot) -> None:
    install_fake_astrbot()
    from astrbot_plugin_ag99live_adapter.transport.websocket_server import WebSocketTransport

    handled: list[bytes] = []
    sent: list[dict] = []

    async def handle_binary_message(payload: bytes) -> None:
        handled.append(payload)

    async def send_json(payload: dict) -> bool:
        sent.append(payload)
        return True

    async def noop_async(*_args, **_kwargs) -> None:
        return None

    transport = WebSocketTransport(
        host="127.0.0.1",
        port=1,
        static_server=object(),
        auto_start_mic=False,
        handle_message=noop_async,
        handle_binary_message=handle_binary_message,
        refresh_runtime_settings_async=noop_async,
        send_current_model_and_conf=noop_async,
        send_motion_tuning_samples_state=noop_async,
        on_disconnect=noop_async,
    )
    transport.send_json = send_json  # type: ignore[method-assign]

    asyncio.run(transport._handle_binary_payload(b"binary-audio"))

    assert handled == [b"binary-audio"]
    assert sent == []
