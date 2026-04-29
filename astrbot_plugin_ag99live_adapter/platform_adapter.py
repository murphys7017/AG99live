from __future__ import annotations

"""AstrBot platform adapter for the AG99live desktop frontend."""

import asyncio
from concurrent.futures import TimeoutError as FutureTimeoutError
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
from .services.frontend_compat_service import FrontendCompatHandler
from .services.history_service import ConversationHistoryBridge
from .services.media_service import MediaService
from .services.message_factory import MessageFactory
from .transport.static_routes import build_static_routes, list_background_files
from .runtime.plugin_runtime import get_plugin_config, get_plugin_context
from .runtime.state import RuntimeState
from .motion.realtime_motion_plan import (
    RealtimeMotionPlanGenerator,
    normalize_motion_intent_payload,
    validate_motion_intent_payload,
    validate_parameter_plan_payload,
)
from .protocol.builder import build_system_motion_tuning_samples_state
from .protocol.constants import TYPE_ENGINE_MOTION_INTENT, TYPE_ENGINE_MOTION_PLAN
from .runtime.session_state import SessionState
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
        "auto_start_mic": True,
    },
)
class OLVPetPlatformAdapter(Platform):
    """Desktop adapter that bridges the AG99live frontend with AstrBot."""

    def __init__(
        self,
        platform_config: dict,
        platform_settings: dict,
        event_queue: asyncio.Queue,
    ) -> None:
        super().__init__(platform_config, event_queue)
        self.config = platform_config
        self.settings = platform_settings or {}

        self.host = _config_get(self.config, "host", "127.0.0.1")
        self.port = int(_config_get(self.config, "port", 12396))
        self.http_port = int(_config_get(self.config, "http_port", 12397))
        self.debug_port = int(_config_get(self.config, "debug_port", 12398))
        self.conf_name = _config_get(self.config, "conf_name", "AG99live Desktop")
        self.conf_uid = _config_get(self.config, "conf_uid", "ag99live-desktop")
        self.speaker_name = _config_get(self.config, "speaker_name", "AstrBot")
        self.auto_start_mic = bool(_config_get(self.config, "auto_start_mic", True))
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
        self.realtime_motion_plan_generator = RealtimeMotionPlanGenerator(
            runtime_state=self.runtime_state,
        )
        self.session_state = SessionState(client_uid=self.client_uid)

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
            api_handler=self._handle_debug_api_request,
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
        self.frontend_compat_handler = FrontendCompatHandler(
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
            refresh_runtime_settings_async=self._refresh_runtime_settings_async,
            send_current_model_and_conf=self._send_current_model_and_conf,
            send_motion_tuning_samples_state=self._send_motion_tuning_samples_state,
            on_disconnect=self._handle_transport_disconnect,
            session_id_getter=lambda: self.client_uid,
        )

        self._vad_engine = None
        self.turn_coordinator = TurnCoordinator(
            session_state=self.session_state,
            runtime_state=self.runtime_state,
            media_service=self.media_service,
            chat_buffer=self.chat_buffer,
            speaker_name=self.speaker_name,
            convert_message=self.message_factory.convert_message,
            build_message_object=self.message_factory.build_message_object,
            handle_frontend_compat=self._handle_frontend_compat,
            refresh_runtime_settings=self._refresh_runtime_settings,
            send_current_model_and_conf=self._send_current_model_and_conf,
            send_json=self.transport.send_json,
            build_platform_event=self._build_platform_event,
            commit_event=self.commit_event,
            ensure_vad_engine=self._ensure_vad_engine,
            generate_realtime_motion_plan=self._generate_realtime_motion_plan,
            realtime_motion_mode_getter=lambda: self.runtime_state.realtime_motion_mode,
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
        unified_msg_origin: str | None = None,
        inline_base_expression: str | None = None,
        inline_motion_id: str | None = None,
        raw_reply_text_override: str | None = None,
    ) -> None:
        await self.turn_coordinator.emit_message_chain(
            message_chain=message_chain,
            unified_msg_origin=unified_msg_origin,
            inline_base_expression=inline_base_expression,
            inline_motion_id=inline_motion_id,
            raw_reply_text_override=raw_reply_text_override,
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
        if not self.runtime_state.should_send_model_payload(payload, force=force):
            return

        sent = await self._send_json(payload)
        if not sent:
            logger.warning(
                "Failed to deliver current model/config payload "
                "(conf_uid=%s, phase=message-only). Will retry on next refresh.",
                self.conf_uid,
            )
            return

        self.runtime_state.mark_model_payload_sent(payload)

    async def _refresh_and_send_current_model_and_conf(self, *, force: bool = False) -> None:
        self._refresh_runtime_settings()
        await self._send_current_model_and_conf(force=force)

    async def _send_motion_tuning_samples_state(self) -> None:
        payload = build_system_motion_tuning_samples_state(
            session_id=self.client_uid,
            samples=self.runtime_state.list_motion_tuning_samples(),
        )
        await self._send_json(payload)

    async def _handle_frontend_compat(self, message: dict[str, Any]) -> None:
        await self.frontend_compat_handler.handle(
            message,
            send_json=self._send_json,
            refresh_and_send_model=self._refresh_and_send_current_model_and_conf,
        )

    async def terminate(self) -> None:
        logger.info("AG99live adapter terminate() called")
        await self.transport.stop()
        await asyncio.to_thread(self._debug_server.stop)
        self._event_loop = None

    async def _send_json(self, payload: dict[str, Any]) -> bool:
        return await self.transport.send_json(payload)

    async def _generate_realtime_motion_plan(
        self,
        *,
        user_text: str,
        assistant_text: str,
    ) -> dict[str, Any] | None:
        return await self.realtime_motion_plan_generator.generate(
            user_text=user_text,
            assistant_text=assistant_text,
        )

    async def _handle_transport_disconnect(self) -> None:
        self.session_state.reset_to_idle()
        await self.turn_coordinator.speech_ingress.handle_audio_stream_interrupt()
        await self.media_service.clear_audio_buffer()

    def _handle_debug_api_request(
        self,
        path: str,
        payload: dict[str, Any],
    ) -> tuple[int, dict[str, Any]]:
        normalized_path = path.rstrip("/")
        if normalized_path not in {
            "/api/engine/motion_payload_preview",
            "/api/engine/motion_plan_preview",
        }:
            return 404, {"ok": False, "error": "Unknown debug API endpoint."}

        if not isinstance(payload, dict):
            return 400, {"ok": False, "error": "Payload must be an object."}

        motion_payload, message_type, failure_reason = _extract_debug_motion_payload(payload)
        if failure_reason:
            return 400, {"ok": False, "error": failure_reason}

        mode = str(payload.get("mode") or "preview").strip() or "preview"
        source = str(payload.get("source") or "analysis.notebook").strip() or "analysis.notebook"

        loop = self._event_loop
        if loop is None:
            return 503, {"ok": False, "error": "Adapter event loop is not ready."}

        future = asyncio.run_coroutine_threadsafe(
            self.turn_coordinator.broadcast_motion_payload(
                motion_payload=motion_payload,
                mode=mode,
                source=source,
            ),
            loop,
        )
        try:
            sent = bool(future.result(timeout=5.0))
        except FutureTimeoutError:
            return 504, {"ok": False, "error": "Timed out while dispatching motion payload preview."}
        except Exception as exc:
            return 500, {"ok": False, "error": f"Failed to dispatch motion payload preview: {exc}"}

        if not sent:
            return 409, {
                "ok": False,
                "error": "No active frontend websocket connection.",
            }

        return 200, {
            "ok": True,
            "status": "dispatched",
            "endpoint": normalized_path,
            "type": message_type,
            "mode": mode,
            "source": source,
        }
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


def _extract_debug_motion_payload(
    payload: dict[str, Any],
) -> tuple[dict[str, Any] | None, str, str]:
    if isinstance(payload.get("intent"), dict):
        try:
            motion_payload = normalize_motion_intent_payload(payload["intent"])
        except ValueError as exc:
            return None, TYPE_ENGINE_MOTION_INTENT, f"Invalid intent payload: {exc}"
        valid, reason = validate_motion_intent_payload(motion_payload)
        if not valid:
            return None, TYPE_ENGINE_MOTION_INTENT, f"Invalid intent payload: {reason}"
        return motion_payload, TYPE_ENGINE_MOTION_INTENT, ""

    if isinstance(payload.get("plan"), dict):
        motion_payload = payload["plan"]
        valid, reason = validate_parameter_plan_payload(motion_payload)
        if not valid:
            return None, TYPE_ENGINE_MOTION_PLAN, f"Invalid plan payload: {reason}"
        return motion_payload, TYPE_ENGINE_MOTION_PLAN, ""

    schema_version = str(payload.get("schema_version") or "").strip()
    if schema_version == "engine.motion_intent.v2":
        try:
            motion_payload = normalize_motion_intent_payload(payload)
        except ValueError as exc:
            return None, TYPE_ENGINE_MOTION_INTENT, f"Invalid intent payload: {exc}"
        valid, reason = validate_motion_intent_payload(motion_payload)
        if not valid:
            return None, TYPE_ENGINE_MOTION_INTENT, f"Invalid intent payload: {reason}"
        return motion_payload, TYPE_ENGINE_MOTION_INTENT, ""

    if schema_version == "engine.parameter_plan.v2":
        valid, reason = validate_parameter_plan_payload(payload)
        if not valid:
            return None, TYPE_ENGINE_MOTION_PLAN, f"Invalid plan payload: {reason}"
        return payload, TYPE_ENGINE_MOTION_PLAN, ""

    return None, "", "`intent` or `plan` must be a valid motion payload object."


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


def _plugin_config_get(config: Any, key: str, default: Any) -> Any:
    if config is None:
        return default
    if hasattr(config, "get"):
        value = config.get(key, default)
        return default if value is None else value
    return default
