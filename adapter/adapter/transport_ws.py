from __future__ import annotations

import asyncio
import json
from typing import Any, Awaitable, Callable

from astrbot.api import logger

from .payload_builder import build_error, build_control, build_full_text


class WebSocketTransport:
    def __init__(
        self,
        *,
        host: str,
        port: int,
        static_server,
        auto_start_mic: bool,
        handle_message: Callable[[dict[str, Any]], Awaitable[None]],
        refresh_runtime_settings_async: Callable[..., Awaitable[None]],
        send_current_model_and_conf: Callable[..., Awaitable[None]],
        on_disconnect: Callable[[], Awaitable[None]],
    ) -> None:
        self.host = host
        self.port = port
        self.static_server = static_server
        self.auto_start_mic = auto_start_mic
        self._handle_message = handle_message
        self._refresh_runtime_settings_async = refresh_runtime_settings_async
        self._send_current_model_and_conf = send_current_model_and_conf
        self._on_disconnect = on_disconnect

        self._ws_server = None
        self._ws_client = None

    async def start(self) -> None:
        logger.debug("Desktop VTuber Adapter transport starting")
        try:
            import websockets  # type: ignore

            await self._refresh_runtime_settings_async(
                reload_persona=True,
                reload_providers=True,
            )
            await asyncio.to_thread(self.static_server.start)

            self._ws_server = await websockets.serve(
                self._handle_client,
                self.host,
                self.port,
                max_size=16 * 1024 * 1024,
            )
            logger.info(
                "OLV Pet Adapter websocket listening on ws://%s:%s",
                self.host,
                self.port,
            )
            await self._ws_server.wait_closed()
        except asyncio.CancelledError:
            logger.debug("Desktop VTuber Adapter transport cancelled")
            await self.stop()
            raise

    async def stop(self) -> None:
        if self._ws_client is not None:
            try:
                await self._ws_client.close()
            except Exception as exc:
                logger.warning("Failed to close desktop websocket client cleanly: %s", exc)
            finally:
                self._ws_client = None

        if self._ws_server is not None:
            try:
                self._ws_server.close()
                await self._ws_server.wait_closed()
            except Exception as exc:
                logger.warning("Failed to close websocket server cleanly: %s", exc)
            finally:
                self._ws_server = None

        if self.static_server is not None:
            try:
                await asyncio.to_thread(self.static_server.stop)
            except Exception as exc:
                logger.warning("Failed to close static resource server cleanly: %s", exc)

    async def send_json(self, payload: dict[str, Any]) -> bool:
        client = self._ws_client
        if client is None:
            return False
        try:
            await client.send(json.dumps(payload, ensure_ascii=False))
            return True
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            if self._ws_client is client:
                self._ws_client = None
            logger.warning(
                "Failed to send websocket payload `%s`: %s",
                payload.get("type", "<unknown>"),
                exc,
            )
            try:
                await client.close()
            except Exception:
                pass
            return False

    async def _handle_client(self, websocket) -> None:
        if self._ws_client is not None:
            await websocket.send(json.dumps(build_error("Only one client is supported.")))
            await websocket.close()
            return

        self._ws_client = websocket
        logger.debug("Desktop frontend connected to adapter transport")
        try:
            await self._send_initial_messages()
            async for raw_message in websocket:
                if isinstance(raw_message, bytes):
                    raw_message = raw_message.decode("utf-8", errors="ignore")
                try:
                    parsed = json.loads(raw_message)
                except json.JSONDecodeError:
                    await self.send_json(build_error("Invalid JSON payload"))
                    continue
                await self._handle_message(parsed)
        finally:
            self._ws_client = None
            await self._on_disconnect()
            logger.debug("Desktop frontend disconnected from adapter transport")

    async def _send_initial_messages(self) -> None:
        await self._refresh_runtime_settings_async(
            reload_persona=True,
            reload_providers=True,
        )
        await self.send_json(build_full_text("Connection established"))
        await self._send_current_model_and_conf(force=True)
        await self.send_json({"type": "group-update", "members": [], "is_owner": False})
        if self.auto_start_mic:
            await self.send_json(build_control("start-mic"))
