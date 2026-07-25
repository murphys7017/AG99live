"""桌面侧 AstrBot 平台适配器 — 组件组装与 AstrBot 钩子响应入口。"""

from __future__ import annotations

import asyncio
from pathlib import Path
import traceback
from typing import Any

from astrbot.api import logger
from astrbot.api.platform import AstrBotMessage, Platform, PlatformMetadata
from astrbot.api.platform import register_platform_adapter
from astrbot.core.platform.astr_message_event import MessageSesion
from astrbot.core.utils.astrbot_path import get_astrbot_plugin_data_path

from .services.audio_runtime import create_vad_engine
from .runtime.chat_buffer import ChatBuffer
from .runtime.client_profile import (
    DEFAULT_CLIENT_NICKNAME,
    DEFAULT_CLIENT_UID,
    normalize_client_nickname,
    normalize_client_uid,
)
from .services.frontend_system_service import FrontendSystemCommandHandler
from .services.history_service import ConversationHistoryBridge
from .services.media_service import MediaService
from .services.message_factory import MessageFactory
from .services.remote_operator_runtime import RemoteOperatorRuntime
from .transport.static_routes import build_static_routes, list_background_files
from .runtime.plugin_runtime import get_plugin_config, get_plugin_context
from .runtime.state import RuntimeState
from .protocol.builder import build_system_motion_tuning_samples_state
from .runtime.session_state import SessionState
from .runtime.turn_identity_map import TurnIdentityMap
from .transport.websocket_server import WebSocketTransport
from .runtime.turn_coordinator import TurnCoordinator
from .platform_event import OLVPetPlatformEvent
from .transport.static_resources import StaticResourceServer

PLUGIN_DIR = Path(__file__).resolve().parent
ASSETS_DIR = PLUGIN_DIR / "assets"
LIVE2DS_DIR = PLUGIN_DIR / "live2ds"
PLUGIN_DATA_DIR = Path(get_astrbot_plugin_data_path()) / PLUGIN_DIR.name
RUNTIME_CACHE_DIR = PLUGIN_DATA_DIR / "cache"
AUDIO_CACHE_DIR = RUNTIME_CACHE_DIR / "audio"
IMAGE_CACHE_DIR = RUNTIME_CACHE_DIR / "images"
SUPPORTED_LOOPBACK_BIND_HOSTS = frozenset({"127.0.0.1", "localhost"})


@register_platform_adapter(
    "olv_pet_adapter",
    "AG99live Adapter",
    default_config_tmpl={
        "host": "127.0.0.1",
        "port": 12396,
        "http_port": 12397,
        "debug_port": 12398,
        "conf_name": "AG99live Desktop",
        "conf_uid": "ag99live-desktop",
        "speaker_name": "AstrBot",
        "auto_start_mic": False,
    },
)
class OLVPetPlatformAdapter(Platform):
    """桌面侧 AstrBot 平台适配器，组装全部后端组件并对外暴露为单条连接。

    持有的组件（按生命周期顺序）：
      - RuntimeState / SessionState / TurnIdentityMap — 配置与轮次状态；
      - StaticResourceServer × 2 — 静态资源 + 调试 API 端口；
      - MediaService — 音频流缓冲 / 缓存 / 图片落地；
      - MessageFactory — 协议消息 → AstrBotMessage；
      - ChatBuffer / ConversationHistoryBridge / FrontendSystemCommandHandler — 业务组合；
      - RemoteOperatorRuntime — 远程操作注入入口；
      - WebSocketTransport — 单连接 WebSocket 入口；
      - TurnCoordinator — 协议 + 轮次中枢（详细职责见 turn_coordinator.py）。

    AstrBot 自身只通过 Platform.run / emit_message_chain / commit_event 等基类钩子
    与它交互；前端只看到 WebSocketTransport + 静态资源 + 调试 API。
    """

    def __init__(
        self,
        platform_config: dict,
        platform_settings: dict,
        event_queue: asyncio.Queue,
    ) -> None:
        super().__init__(platform_config, event_queue)
        self.config = platform_config
        self.settings = platform_settings or {}

        self.host = _require_loopback_host(
            _config_get(self.config, "host", "127.0.0.1")
        )
        self.port = int(_config_get(self.config, "port", 12396))
        self.http_port = int(_config_get(self.config, "http_port", 12397))
        self.debug_port = int(_config_get(self.config, "debug_port", 12398))
        self.conf_name = _config_get(self.config, "conf_name", "AG99live Desktop")
        self.conf_uid = _config_get(self.config, "conf_uid", "ag99live-desktop")
        self.speaker_name = _config_get(self.config, "speaker_name", "AstrBot")
        self.auto_start_mic = bool(_config_get(self.config, "auto_start_mic", False))
        self._event_loop: asyncio.AbstractEventLoop | None = None

        self._plugin_context = get_plugin_context()
        self._plugin_config = get_plugin_config() or {}

        self.client_uid = normalize_client_uid(
            _plugin_config_get(self._plugin_config, "client_uid", DEFAULT_CLIENT_UID),
            DEFAULT_CLIENT_UID,
        )
        self.client_nickname = normalize_client_nickname(
            _plugin_config_get(
                self._plugin_config,
                "client_nickname",
                DEFAULT_CLIENT_NICKNAME,
            ),
            DEFAULT_CLIENT_NICKNAME,
        )

        self.runtime_state = RuntimeState(
            platform_config=self.config,
            plugin_context=self._plugin_context,
            plugin_config=self._plugin_config,
            plugin_config_loader=get_plugin_config,
            host=self.host,
            http_port=self.http_port,
            client_uid=self.client_uid,
            live2ds_dir=LIVE2DS_DIR,
            runtime_cache_dir=RUNTIME_CACHE_DIR,
        )
        self.session_state = SessionState(client_uid=self.client_uid)
        self.turn_identity_map = TurnIdentityMap()

        self._static_server = StaticResourceServer(
            host=self.host,
            port=self.http_port,
            routes=build_static_routes(
                live2ds_dir=LIVE2DS_DIR,
                assets_dir=ASSETS_DIR,
                runtime_cache_dir=RUNTIME_CACHE_DIR,
            ),
        )
        self._debug_server = StaticResourceServer(
            host=self.host,
            port=self.debug_port,
            routes={},
        )
        self.media_service = MediaService(
            host=self.host,
            http_port=self.http_port,
            live2ds_dir=LIVE2DS_DIR,
            olv_dir=ASSETS_DIR,
            audio_cache_dir=AUDIO_CACHE_DIR,
            image_cache_dir=IMAGE_CACHE_DIR,
        )
        self.message_factory = MessageFactory(
            client_uid=self.client_uid,
            nickname=self.client_nickname,
            media_service=self.media_service,
            image_cooldown_seconds_getter=lambda: self.runtime_state.image_cooldown_seconds,
        )
        self.chat_buffer = ChatBuffer(
            maxlen=int(_plugin_config_get(self.runtime_state.plugin_config, "chat_buffer_size", 10))
        )
        self.history_bridge = ConversationHistoryBridge(
            plugin_context=self._plugin_context,
            platform_id="olv_pet_adapter",
            client_uid=self.client_uid,
            speaker_name=self.speaker_name,
            chat_buffer=self.chat_buffer,
        )
        self.frontend_system_handler = FrontendSystemCommandHandler(
            background_files_getter=lambda: list_background_files(ASSETS_DIR),
            history_bridge=self.history_bridge,
            runtime_state=self.runtime_state,
        )
        self.transport = WebSocketTransport(
            host=self.host,
            port=self.port,
            static_server=self._static_server,
            auto_start_mic=self.auto_start_mic,
            handle_message=self.handle_msg,
            handle_binary_message=self.handle_binary_msg,
            refresh_runtime_settings_async=self._refresh_runtime_settings_async,
            send_current_model_and_conf=self._send_current_model_and_conf,
            send_motion_tuning_samples_state=self._send_motion_tuning_samples_state,
            on_disconnect=self._handle_transport_disconnect,
        )
        self.remote_operator_runtime = RemoteOperatorRuntime(
            plugin_config_loader=get_plugin_config,
            submit_system_text_input=self._submit_remote_operator_system_text_input,
        )

        self._vad_engine = None
        self.turn_coordinator = TurnCoordinator(
            session_state=self.session_state,
            turn_identity_map=self.turn_identity_map,
            runtime_state=self.runtime_state,
            media_service=self.media_service,
            chat_buffer=self.chat_buffer,
            speaker_name=self.speaker_name,
            convert_message=self.message_factory.convert_message,
            build_message_object=self.message_factory.build_message_object,
            handle_frontend_system=self._handle_frontend_system,
            refresh_runtime_settings=self._refresh_runtime_settings,
            send_current_model_and_conf=self._send_current_model_and_conf,
            send_json=self.transport.send_json,
            build_platform_event=self._build_platform_event,
            commit_event=self.commit_event,
            ensure_vad_engine=self._ensure_vad_engine,
        )

        logger.debug(
            "AG99live adapter initialized "
            f"(host={self.host}, ws_port={self.port}, http_port={self.http_port}, "
            f"debug_port={self.debug_port}, "
            f"conf_name={self.conf_name}, conf_uid={self.conf_uid})"
        )
        self._refresh_runtime_settings()

    def meta(self) -> PlatformMetadata:
        return PlatformMetadata(
            name="olv_pet_adapter",
            description="AG99live desktop adapter",
            id="olv_pet_adapter",
        )

    @property
    def vad_model(self) -> str:
        return self.runtime_state.vad_model

    @property
    def vad_config(self) -> dict[str, Any]:
        return self.runtime_state.vad_config

    @property
    def model_info(self) -> dict[str, Any]:
        return self.runtime_state.model_info

    @property
    def image_cooldown_seconds(self) -> int:
        return self.runtime_state.image_cooldown_seconds

    @property
    def _default_persona(self) -> dict[str, Any] | None:
        return self.runtime_state.default_persona

    @property
    def _selected_stt_provider(self):
        return self.runtime_state.selected_stt_provider

    @property
    def _selected_motion_analysis_provider(self):
        return self.runtime_state.selected_motion_analysis_provider

    async def run(self):
        self._event_loop = asyncio.get_running_loop()
        try:
            await asyncio.to_thread(self._debug_server.start)
            self.remote_operator_runtime.start()
            await self.transport.start()
        except asyncio.CancelledError:
            await self.terminate()
            raise
        except Exception as exc:
            logger.error(f"AG99live adapter failed during run(): {exc}")
            logger.error(traceback.format_exc())
            raise
        finally:
            await asyncio.to_thread(self._debug_server.stop)
            self._event_loop = None

    async def send_by_session(self, session: MessageSesion, message_chain):
        turn_id = await self.turn_coordinator.begin_proactive_output_turn()
        try:
            await self.emit_message_chain(
                message_chain=message_chain,
                turn_id=turn_id,
                unified_msg_origin=str(session),
                platform_extras={"logical_message_id": "proactive_reply"},
            )
            await self.turn_coordinator.close_turn_output_queue(turn_id=turn_id)
        except asyncio.CancelledError:
            await self.turn_coordinator.fail_proactive_output_turn(
                turn_id=turn_id,
                reason="proactive_output_cancelled",
            )
            raise
        except Exception:
            await self.turn_coordinator.fail_proactive_output_turn(
                turn_id=turn_id,
                reason="proactive_output_delivery_failed",
            )
            raise
        await super().send_by_session(session, message_chain)

    def convert_message(self, data: dict[str, Any]) -> AstrBotMessage:
        return self.message_factory.convert_message(data)

    def _build_message_object(
        self,
        text: str,
        raw_message: dict[str, Any],
        images: list[Any] | None = None,
    ) -> AstrBotMessage:
        return self.message_factory.build_message_object(
            text=text,
            raw_message=raw_message,
            images=images,
        )

    def _build_platform_event(self, message_obj: AstrBotMessage) -> OLVPetPlatformEvent:
        return OLVPetPlatformEvent(
            message_obj.message_str,
            message_obj,
            self.meta(),
            message_obj.session_id,
            self,
        )

    async def handle_msg(self, message: dict[str, Any]):
        await self.turn_coordinator.handle_msg(message)

    async def handle_binary_msg(self, message: bytes):
        await self.turn_coordinator.handle_binary_msg(message)

    def _ensure_vad_engine(self):
        if self._vad_engine is not None:
            return self._vad_engine
        self._vad_engine = create_vad_engine(
            olv_dir=ASSETS_DIR,
            engine_type=self.vad_model,
            kwargs=self.vad_config,
        )
        return self._vad_engine

    async def emit_message_chain(
        self,
        message_chain,
        turn_id: str,
        unified_msg_origin: str | None = None,
        raw_reply_text_override: str | None = None,
        platform_extras: dict[str, Any] | None = None,
    ) -> None:
        """AstrBot 在产出 LLM 回复后回调的入口；纯透传到 TurnCoordinator.emit_message_chain。

        参数含义、发送顺序与 motion 分发策略都在 turn_coordinator 那一层；
        本方法只负责把命名参数一一对应。
        """
        await self.turn_coordinator.emit_message_chain(
            message_chain=message_chain,
            turn_id=turn_id,
            unified_msg_origin=unified_msg_origin,
            raw_reply_text_override=raw_reply_text_override,
            platform_extras=platform_extras,
        )

    def _refresh_runtime_settings(self) -> None:
        vad_settings_changed = self.runtime_state.refresh()
        self._sync_client_profile_from_runtime_state()
        if self._vad_engine is not None and vad_settings_changed:
            self._vad_engine = None

    async def _refresh_runtime_settings_async(
        self,
        *,
        reload_persona: bool = False,
        reload_providers: bool = False,
    ) -> None:
        vad_settings_changed = await self.runtime_state.refresh_async(
            reload_persona=reload_persona,
            reload_providers=reload_providers,
        )
        self._sync_client_profile_from_runtime_state()
        if self._vad_engine is not None and vad_settings_changed:
            self._vad_engine = None

    async def _send_current_model_and_conf(self, *, force: bool = False) -> None:
        payload = self.runtime_state.build_current_model_payload(
            conf_name=self.conf_name,
            conf_uid=self.conf_uid,
            client_uid=self.client_uid,
        )
        signature = self.runtime_state.build_model_payload_signature(payload)
        if not self.runtime_state.should_send_model_payload(signature, force=force):
            return

        sent = await self._send_json(payload)
        if not sent:
            logger.warning(
                "Failed to deliver current model/config payload "
                "(conf_uid=%s, phase=message-only). Will retry on next refresh.",
                self.conf_uid,
            )
            return

        self.runtime_state.mark_model_payload_sent(signature)

    async def _refresh_and_send_current_model_and_conf(self, *, force: bool = False) -> None:
        self._refresh_runtime_settings()
        await self._send_current_model_and_conf(force=force)

    async def _send_motion_tuning_samples_state(self) -> None:
        payload = build_system_motion_tuning_samples_state(
            samples=self.runtime_state.list_motion_tuning_samples(),
            root_error=self.runtime_state.get_runtime_cache_root_error(),
            load_error=self.runtime_state.get_motion_tuning_samples_load_error(),
            diagnostics=self.runtime_state.list_motion_tuning_fewshot_diagnostics(),
            effective_examples=self.runtime_state.list_effective_motion_tuning_examples(),
        )
        await self._send_json(payload)

    async def _handle_frontend_system(self, message: dict[str, Any]) -> None:
        await self.frontend_system_handler.handle(
            message,
            send_json=self._send_json,
            refresh_and_send_model=self._refresh_and_send_current_model_and_conf,
        )

    async def terminate(self) -> None:
        logger.info("AG99live adapter terminate() called")
        await self.remote_operator_runtime.stop()
        await self.transport.stop()
        motion_lab_recorder = getattr(self.runtime_state, "motion_lab_recorder", None)
        close_motion_lab = getattr(motion_lab_recorder, "close", None)
        try:
            if callable(close_motion_lab):
                await close_motion_lab()
        finally:
            await asyncio.to_thread(self._debug_server.stop)
            self._event_loop = None

    def spawn_background_task(self, coroutine) -> None:
        if self._event_loop is not None and self._event_loop.is_running():
            self.turn_coordinator._spawn_background_task(coroutine)
            return
        asyncio.create_task(coroutine)

    async def _submit_remote_operator_system_text_input(
        self,
        text: str,
        metadata: dict[str, Any],
    ) -> None:
        await self.turn_coordinator.submit_system_text_input(text, metadata)

    async def _send_json(self, payload: dict[str, Any]) -> bool:
        return await self.transport.send_json(payload)

    async def _handle_transport_disconnect(self) -> None:
        """WebSocket 断开时调用的清理钩子。

        顺序固定：停止 TurnCoordinator 中的在飞 AstrBot 事件并清理连接级状态，session_state → idle，
        turn_identity_map 全清，调
        speech_ingress.handle_audio_stream_interrupt 中断所有在飞的音频流，
        media_service.clear_audio_buffer 丢弃缓冲。
        """
        self.turn_coordinator.reset_turn_tracking()
        self.session_state.reset_to_idle()
        self.turn_identity_map.clear_all()
        await self.turn_coordinator.speech_ingress.handle_audio_stream_interrupt()
        await self.media_service.clear_audio_buffer()

    def _sync_client_profile_from_runtime_state(self) -> None:
        self.client_uid = normalize_client_uid(
            getattr(self.runtime_state, "client_uid", self.client_uid),
            DEFAULT_CLIENT_UID,
        )
        self.client_nickname = normalize_client_nickname(
            getattr(self.runtime_state, "client_nickname", self.client_nickname),
            DEFAULT_CLIENT_NICKNAME,
        )
        self.session_state.client_uid = self.client_uid
        self.message_factory.set_client_profile(
            self.client_uid,
            self.client_nickname,
        )
        self.history_bridge.set_client_uid(self.client_uid)


def _config_get(config: Any, key: str, default: Any) -> Any:
    if config is None:
        return default
    if hasattr(config, "get"):
        value = config.get(key, default)
        return default if value is None else value
    if hasattr(config, key):
        value = getattr(config, key)
        return default if value is None else value
    return default


def _require_loopback_host(value: Any) -> str:
    host = str(value or "").strip().lower()
    if host not in SUPPORTED_LOOPBACK_BIND_HOSTS:
        raise ValueError(
            "ag99live_transport_host_must_use_supported_loopback:"
            f"{host or '<empty>'}"
        )
    return host


def _plugin_config_get(config: Any, key: str, default: Any) -> Any:
    if config is None:
        return default
    if hasattr(config, "get"):
        value = config.get(key, default)
        return default if value is None else value
    return default
