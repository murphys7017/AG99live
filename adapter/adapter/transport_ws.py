from __future__ import annotations

import asyncio
import json
from typing import Any, Awaitable, Callable

from astrbot.api import logger
from websockets.exceptions import ConnectionClosedError, ConnectionClosedOK

from ..protocol.builder import (
    build_control_error,
    build_control_start_mic,
    build_system_group_update,
    build_system_server_info,
)


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
        session_id_getter: Callable[[], str],
    ) -> None:
        self.host = host
        self.port = port
        self.static_server = static_server
        self.auto_start_mic = auto_start_mic
        self._handle_message = handle_message
        self._refresh_runtime_settings_async = refresh_runtime_settings_async
        self._send_current_model_and_conf = send_current_model_and_conf
        self._on_disconnect = on_disconnect
        self._session_id_getter = session_id_getter

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
                "AG99live websocket listening on ws://%s:%s",
                self.host,
                self.port,
            )
            await self._ws_server.wait_closed()
        except asyncio.CancelledError:
            logger.debug("Desktop VTuber Adapter transport cancelled")
            await self.stop()
            raise
        except Exception:
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
            await websocket.send(
                json.dumps(
                    build_control_error(
                        session_id=self._session_id(),
                        message="Only one client is supported.",
                    ),
                    ensure_ascii=False,
                )
            )
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
                    await self.send_json(
                        build_control_error(
                            session_id=self._session_id(),
                            message="Invalid JSON payload",
                        )
                    )
                    continue
                if not isinstance(parsed, dict):
                    await self.send_json(
                        build_control_error(
                            session_id=self._session_id(),
                            message="JSON payload must be an object",
                        )
                    )
                    continue
                try:
                    await self._handle_message(parsed)
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    logger.warning("Failed to process inbound websocket payload: %s", exc)
                    await self.send_json(
                        build_control_error(
                            session_id=self._session_id(),
                            message=f"Failed to process message: {exc}",
                        )
                    )
        except asyncio.CancelledError:
            raise
        except ConnectionClosedOK:
            logger.debug("Desktop frontend websocket closed cleanly")
        except ConnectionClosedError as exc:
            logger.debug(
                "Desktop frontend websocket closed without a graceful close frame: %s",
                exc,
            )
        except Exception as exc:
            if _is_expected_disconnect_error(exc):
                logger.debug("Desktop frontend disconnected abruptly: %s", exc)
            else:
                logger.warning("Desktop frontend handler aborted unexpectedly: %s", exc)
        finally:
            self._ws_client = None
            try:
                await self._on_disconnect()
            except Exception as exc:
                logger.warning("Failed to run disconnect cleanup: %s", exc)
            logger.debug("Desktop frontend disconnected from adapter transport")

    async def _send_initial_messages(self) -> None:
        session_id = self._session_id()
        await self._refresh_runtime_settings_async(
            reload_persona=True,
            reload_providers=True,
        )
        await self.send_json(
            build_system_server_info(
                session_id=session_id,
                ws_url=f"ws://{self.host}:{self.port}",
                http_base_url=f"http://{self.static_server.host}:{self.static_server.port}",
                auto_start_mic=self.auto_start_mic,
            )
        )
        await self._send_current_model_and_conf(force=True)
        await self.send_json(
            build_system_group_update(
                session_id=session_id,
                members=[],
                is_owner=False,
            )
        )
        if self.auto_start_mic:
            await self.send_json(build_control_start_mic(session_id=session_id))

    def _session_id(self) -> str:
        session_id = self._session_id_getter()
        return session_id or "desktop-client"


def _is_expected_disconnect_error(exc: Exception) -> bool:
    if isinstance(exc, (ConnectionClosedError, ConnectionClosedOK, ConnectionResetError, BrokenPipeError)):
        return True

    if isinstance(exc, OSError):
        winerror = getattr(exc, "winerror", None)
        if winerror in {64, 10054}:
            return True

    message = str(exc).lower()
    return "no close frame received or sent" in message or "network name is no longer available" in message
