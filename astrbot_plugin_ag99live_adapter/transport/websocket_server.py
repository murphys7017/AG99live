"""WebSocket 传输层：单前端连接 + 配套静态资源服务。"""

from __future__ import annotations

import asyncio
import json
from typing import Any, Awaitable, Callable

from astrbot.api import logger
from websockets.exceptions import ConnectionClosedError, ConnectionClosedOK

from ..protocol.builder import (
    build_control_error,
    build_control_start_mic,
    build_system_server_info,
)


class WebSocketTransport:
    """单连接的 WebSocket 传输 + 静态资源进程。

    同一进程同时起两样东西：
      - 一个 websockets.serve 单端口服务器（self._ws_server），最多一个客户端
        （self._ws_client）；新连接在已有客户端时会回 control.error 后立刻关掉；
      - 通过构造时注入的 static_server.start / .stop 启停 HTTP 静态资源路由，
        用来给前端提供 /cache/audio/*.wav 等媒体文件。

    自身不解析任何业务消息：所有入站文本/二进制都转手给 handle_message /
    handle_binary_message 回调；出站只暴露 send_json。回调用法见 __init__ 形参。
    """

    def __init__(
        self,
        *,
        host: str,
        port: int,
        static_server,
        auto_start_mic: bool,
        handle_message: Callable[[dict[str, Any]], Awaitable[None]],
        handle_binary_message: Callable[[bytes], Awaitable[None]] | None = None,
        refresh_runtime_settings_async: Callable[..., Awaitable[None]],
        send_current_model_and_conf: Callable[..., Awaitable[bool]],
        send_motion_tuning_samples_state: Callable[..., Awaitable[bool]],
        on_disconnect: Callable[[], Awaitable[None]],
    ) -> None:
        self.host = host
        self.port = port
        self.static_server = static_server
        self.auto_start_mic = auto_start_mic
        self._handle_message = handle_message
        self._handle_binary_message = handle_binary_message
        self._refresh_runtime_settings_async = refresh_runtime_settings_async
        self._send_current_model_and_conf = send_current_model_and_conf
        self._send_motion_tuning_samples_state = send_motion_tuning_samples_state
        self._on_disconnect = on_disconnect

        self._ws_server = None
        self._ws_client = None

    async def start(self) -> None:
        """启动静态资源 + WebSocket 监听；直到 ws_server.wait_closed()。

        启动顺序：先刷新 runtime settings 与 providers，
        再 to_thread 起 static_server，最后 websockets.serve。CancelledError
        与其它异常都会在退出前调 stop() 回收静态服务器与 WS 句柄，再重新抛。
        """
        logger.debug("Desktop VTuber Adapter transport starting")
        try:
            import websockets  # type: ignore

            await self._refresh_runtime_settings_async(
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
                if _is_expected_disconnect_error(exc):
                    logger.debug("Desktop websocket client was already disconnected: %s", exc)
                else:
                    logger.exception("Failed to close desktop websocket client cleanly")
            finally:
                self._ws_client = None

        if self._ws_server is not None:
            try:
                self._ws_server.close()
                await self._ws_server.wait_closed()
            except Exception:
                logger.exception("Failed to close websocket server cleanly")
            finally:
                self._ws_server = None

        if self.static_server is not None:
            try:
                await asyncio.to_thread(self.static_server.stop)
            except Exception:
                logger.exception("Failed to close static resource server cleanly")

    async def send_json(self, payload: dict[str, Any]) -> bool:
        """出站发送：把 dict 序列化为 JSON 经当前 _ws_client 发出。

        没有客户端时直接返回 False，不抛；发送过程中异常会清空 _ws_client 并
        尝试 close 旧连接再返回 False。CancelledError 透传，调用方需要捕获。
        """
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
            if _is_expected_disconnect_error(exc):
                logger.debug(
                    "Desktop websocket disconnected while sending `%s`: %s",
                    payload.get("type", "<unknown>"),
                    exc,
                )
            else:
                logger.exception(
                    "Failed to send websocket payload `%s`",
                    payload.get("type", "<unknown>"),
                )
            try:
                await client.close()
            except Exception as close_exc:
                if _is_expected_disconnect_error(close_exc):
                    logger.debug(
                        "Desktop websocket was already closed after send failure: %s",
                        close_exc,
                    )
                else:
                    logger.exception("Failed to close websocket client after send failure")
            return False

    async def _handle_client(self, websocket) -> None:
        """每条新连接的主循环。

        行为：
          - 若已有 _ws_client，回 control.error 后立刻关掉（单客户端契约）；
          - 否则注册 _ws_client，发 _send_initial_messages 初始化一份快照（server_info
            / model / motion samples / group / 可能的 start_mic）；
          - 进入 async for raw_message：
              bytes  → _handle_binary_payload；
              JSON 解析失败 / 解析结果不是 dict → 发 control.error 后继续；
              其它  → 调 handle_message；handle_message 抛错时同样回 control.error
            而不断连（只丢这一条消息）。
          - 退出时无论是 CancelledError / ConnectionClosedOK / ConnectionClosedError
            / 其它，都先清 _ws_client、跑 on_disconnect 钩子再 return。
        """
        if self._ws_client is not None:
            await websocket.send(
                json.dumps(
                    build_control_error(
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
                    await self._handle_binary_payload(raw_message)
                    continue
                try:
                    parsed = json.loads(raw_message)
                except json.JSONDecodeError:
                    await self.send_json(
                        build_control_error(
                            message="Invalid JSON payload",
                        )
                    )
                    continue
                if not isinstance(parsed, dict):
                    await self.send_json(
                        build_control_error(
                            message="JSON payload must be an object",
                        )
                    )
                    continue
                try:
                    await self._handle_message(parsed)
                except asyncio.CancelledError:
                    raise
                except Exception:
                    logger.exception("Failed to process inbound websocket payload")
                    turn_id = parsed.get("turn_id")
                    await self.send_json(
                        build_control_error(
                            turn_id=(
                                turn_id.strip()
                                if isinstance(turn_id, str) and turn_id.strip()
                                else None
                            ),
                            message="Failed to process message.",
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
                logger.exception("Desktop frontend handler aborted unexpectedly")
        finally:
            self._ws_client = None
            try:
                await self._on_disconnect()
            except Exception:
                logger.exception("Failed to run disconnect cleanup")
            logger.debug("Desktop frontend disconnected from adapter transport")

    async def _handle_binary_payload(self, raw_message: bytes) -> None:
        if self._handle_binary_message is None:
            await self.send_json(
                build_control_error(
                    message="Binary websocket payloads are not supported by this adapter.",
                )
            )
            return
        try:
            await self._handle_binary_message(raw_message)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Failed to process inbound binary websocket payload")
            await self.send_json(
                build_control_error(
                    message="Failed to process binary message.",
                )
            )

    async def _send_initial_messages(self) -> None:
        """新客户端连上后立刻广播的初始化快照。

        顺序固定：refresh runtime → server_info → current_model_and_conf(force=True)
        → motion_tuning_samples_state，最后如果 auto_start_mic=True 再发
        control.start_mic。
        """
        await self._refresh_runtime_settings_async(
            reload_providers=True,
        )
        server_info_sent = await self.send_json(
            build_system_server_info(
                ws_url=f"ws://{self.host}:{self.port}",
                http_base_url=f"http://{self.static_server.host}:{self.static_server.port}",
                auto_start_mic=self.auto_start_mic,
            )
        )
        if not server_info_sent:
            raise RuntimeError("initial_server_info_send_failed")
        if not await self._send_current_model_and_conf(force=True):
            raise RuntimeError("initial_model_sync_send_failed")
        if not await self._send_motion_tuning_samples_state():
            raise RuntimeError("initial_motion_tuning_state_send_failed")
        if self.auto_start_mic and not await self.send_json(build_control_start_mic()):
            raise RuntimeError("initial_start_mic_send_failed")


def _is_expected_disconnect_error(exc: Exception) -> bool:
    if isinstance(exc, (ConnectionClosedError, ConnectionClosedOK, ConnectionResetError, BrokenPipeError)):
        return True

    if isinstance(exc, OSError):
        winerror = getattr(exc, "winerror", None)
        if winerror in {64, 10054}:
            return True

    message = str(exc).lower()
    return "no close frame received or sent" in message or "network name is no longer available" in message
