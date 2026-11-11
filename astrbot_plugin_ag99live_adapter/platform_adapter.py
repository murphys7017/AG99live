"""桌面侧 AstrBot 平台适配器 — 组件组装与 AstrBot 钩子响应入口。"""

from __future__ import annotations

import asyncio
import inspect
from pathlib import Path
from typing import Any
from uuid import uuid4

from astrbot.api import logger
from astrbot.api.platform import AstrBotMessage, Platform, PlatformMetadata
from astrbot.api.platform import register_platform_adapter
from astrbot.core.platform.astr_message_event import MessageSesion
from astrbot.core.utils.astrbot_path import get_astrbot_plugin_data_path

from .services.audio_runtime import create_vad_engine as create_stream_vad_engine
from .runtime.chat_buffer import ChatBuffer
from .runtime.client_profile import (
    DEFAULT_CLIENT_NICKNAME,
    DEFAULT_CLIENT_UID,
    normalize_client_nickname,
    normalize_client_uid,
)
from .runtime.adapter_event_context import resolve_adapter_event_context
from .services.frontend_system_service import FrontendSystemCommandHandler
from .services.history_service import ConversationHistoryBridge
from .services.media_service import MediaService
from .services.message_factory import MessageFactory
from .services.input_preparation import InputPreparation
from .transport.static_routes import build_static_routes, list_background_files
from .runtime.plugin_runtime import (
    ADAPTER_PLATFORM_NAME,
    ADAPTER_DISPLAY_NAME,
    get_config_value,
    register_control_platform,
    get_plugin_config_snapshot,
    get_plugin_context,
    get_persisted_desktop_settings,
    persist_desktop_setting,
    unregister_control_platform,
)
from .runtime.state import RuntimeState
from .protocol.builder import build_system_motion_tuning_samples_state
from .protocol.constants import (
    TYPE_SYSTEM_DESKTOP_RUNTIME_SETTINGS,
    TYPE_SYSTEM_DESKTOP_SETTINGS_RESULT,
    TYPE_SYSTEM_DESKTOP_SETTINGS_UPDATE,
)
from .runtime.desktop_settings_broker import DesktopSettingsBroker
from .runtime.desktop_observation import DesktopFrameBroker, SCHEMA
from .runtime.desktop_presence import DesktopPresenceBroker
from .protocol.desktop_presence import SCHEMA as PRESENCE_SCHEMA
from .runtime.session_state import SessionState
from .runtime.turn_identity_map import TurnIdentityMap
from .transport.websocket_server import WebSocketTransport
from .runtime.turn_coordinator import TurnCoordinator
from .runtime.passive_behavior import PassiveBehaviorRuntime
from .runtime.interaction_orchestrator import InteractionOrchestrator, ProviderEvent
from .runtime.conversation_event_assembler import TextConversationEventAssembler
from .adapters.dsh import DshHarnessConfig, DshHarnessConversationProvider
from .platform_event import OLVPetPlatformEvent
from .transport.static_resources import StaticResourceServer
from .adapters.astrbot.provider_bridge import (
    AstrBotAvatarOutputPort,
    ProviderBridgeCallbacks,
)
from .adapters.astrbot.capabilities import AstrBotCapabilityBinding
from .adapters.astrbot.provider_registry import AstrBotProviderRegistry
from .adapters.astrbot.composition import (
    AstrBotProviderBinding,
    build_provider_bridge,
)
from .providers.contracts import (
    ConversationInput,
)

PLUGIN_DIR = Path(__file__).resolve().parent
ASSETS_DIR = PLUGIN_DIR / "assets"
LIVE2DS_DIR = PLUGIN_DIR / "live2ds"
PLUGIN_DATA_DIR = Path(get_astrbot_plugin_data_path()) / PLUGIN_DIR.name
RUNTIME_CACHE_DIR = PLUGIN_DATA_DIR / "cache"
PUBLIC_CACHE_DIR = PLUGIN_DATA_DIR / "public_cache"
AUDIO_CACHE_DIR = PUBLIC_CACHE_DIR / "audio"
IMAGE_CACHE_DIR = PUBLIC_CACHE_DIR / "images"
STATE_DIR = PLUGIN_DATA_DIR / "state"
LOOPBACK_BIND_HOST = "127.0.0.1"


def _register_ag99live_adapter(adapter_class: type[Platform]) -> type[Platform]:
    """Register with optional metadata supported by newer AstrBot cores."""
    registration_kwargs: dict[str, Any] = {
        "default_config_tmpl": {
            "port": 12396,
            "http_port": 12397,
            "speaker_name": "AstrBot",
            "auto_start_mic": False,
        },
    }
    try:
        parameters = inspect.signature(register_platform_adapter).parameters
    except (TypeError, ValueError):
        parameters = {}
    if "adapter_display_name" in parameters:
        registration_kwargs["adapter_display_name"] = ADAPTER_DISPLAY_NAME
    return register_platform_adapter(
        ADAPTER_PLATFORM_NAME,
        "AG99live 桌宠连接适配器",
        **registration_kwargs,
    )(adapter_class)


@_register_ag99live_adapter
class OLVPetPlatformAdapter(Platform):
    """桌面侧 AstrBot 平台适配器，组装全部后端组件并对外暴露为单条连接。

    持有的组件（按生命周期顺序）：
      - RuntimeState / SessionState / TurnIdentityMap — 配置与轮次状态；
      - StaticResourceServer — Live2D、图片和音频静态资源；
      - MediaService — 音频流缓冲 / 缓存 / 图片落地；
      - MessageFactory — 协议消息 → AstrBotMessage；
      - ChatBuffer / ConversationHistoryBridge / FrontendSystemCommandHandler — 业务组合；
      - WebSocketTransport — 单连接 WebSocket 入口；
      - TurnCoordinator — 协议 + 轮次中枢（详细职责见 turn_coordinator.py）。

    AstrBot 自身只通过 Platform.run / emit_message_chain / commit_event 等基类钩子
    与它交互；前端只看到 WebSocketTransport 和静态资源。
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
        self.platform_id = str(self.config["id"]).strip()

        self.host = LOOPBACK_BIND_HOST
        self.port = int(get_config_value(self.config, "port", 12396))
        self.http_port = int(get_config_value(self.config, "http_port", 12397))
        self.speaker_name = get_config_value(self.config, "speaker_name", "AstrBot")
        self.auto_start_mic = bool(get_config_value(self.config, "auto_start_mic", False))
        self.desktop_persona_segment_stream_enabled = False
        self.desktop_audio_credit_enabled = False
        self._event_loop: asyncio.AbstractEventLoop | None = None
        self._external_conversation_tasks: set[asyncio.Task] = set()

        self._plugin_context = get_plugin_context()
        plugin_config_snapshot = get_plugin_config_snapshot()
        self._plugin_config = plugin_config_snapshot.config
        general_config = get_config_value(self._plugin_config, "general", {})

        self.client_uid = normalize_client_uid(
            get_config_value(general_config, "client_uid", DEFAULT_CLIENT_UID),
            DEFAULT_CLIENT_UID,
        )
        self.client_nickname = normalize_client_nickname(
            get_config_value(
                general_config,
                "client_nickname",
                DEFAULT_CLIENT_NICKNAME,
            ),
            DEFAULT_CLIENT_NICKNAME,
        )

        self.runtime_state = RuntimeState(
            platform_config=self.config,
            plugin_context=self._plugin_context,
            provider_registry=AstrBotProviderRegistry(
                self._plugin_context,
                platform_id=self.platform_id,
            ),
            plugin_config=self._plugin_config,
            plugin_config_loader=get_plugin_config_snapshot,
            host=self.host,
            http_port=self.http_port,
            platform_id=self.platform_id,
            client_uid=self.client_uid,
            live2ds_dir=LIVE2DS_DIR,
            runtime_cache_dir=RUNTIME_CACHE_DIR,
            state_dir=STATE_DIR,
        )
        self.session_state = SessionState(client_uid=self.client_uid)
        self.turn_identity_map = TurnIdentityMap()

        self._static_server = StaticResourceServer(
            host=self.host,
            port=self.http_port,
            routes=build_static_routes(
                live2ds_dir=LIVE2DS_DIR,
                assets_dir=ASSETS_DIR,
                audio_cache_dir=AUDIO_CACHE_DIR,
                image_cache_dir=IMAGE_CACHE_DIR,
            ),
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
            self_id=self.platform_id,
            client_uid=self.client_uid,
            nickname=self.client_nickname,
            media_service=self.media_service,
            image_cooldown_seconds_getter=lambda: self.runtime_state.image_cooldown_seconds,
        )
        self.chat_buffer = ChatBuffer(
            maxlen=int(get_config_value(general_config, "chat_buffer_size", 10))
        )
        self.history_bridge = ConversationHistoryBridge(
            plugin_context=self._plugin_context,
            platform_id=self.platform_id,
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
            synchronize_desktop_settings=self._synchronize_desktop_settings,
            on_disconnect=self._handle_transport_disconnect,
        )
        self.desktop_observation = DesktopFrameBroker(self.transport.send_json)
        self.desktop_presence = DesktopPresenceBroker(self.transport.send_json)
        self.desktop_settings_broker = DesktopSettingsBroker(
            send_json=self.transport.send_json,
            is_connected=lambda: self.transport._ws_client is not None,
            get_canonical_snapshot=lambda: get_persisted_desktop_settings(
                self.platform_id,
            ),
            persist_entry=lambda key, entry: persist_desktop_setting(
                self.platform_id,
                key,
                entry,
            ),
            is_allowed_key=self._is_desktop_setting_key,
        )
        self.avatar_output_port = AstrBotAvatarOutputPort(
            send_json=self.transport.send_json,
        )
        conversation_config = get_config_value(
            self._plugin_config,
            "conversation",
            {},
        )
        selected_conversation_platform = str(
            get_config_value(conversation_config, "platform", "astrbot")
            or "astrbot"
        ).strip().lower()
        self.conversation_platform = (
            selected_conversation_platform
            if selected_conversation_platform in {"astrbot", "dsh"}
            else "astrbot"
        )
        self.dsh_provider = None
        if self.conversation_platform == "dsh":
            self.dsh_provider = DshHarnessConversationProvider(
                DshHarnessConfig(
                    dsh_bin=str(get_config_value(conversation_config, "dsh_bin", "") or "").strip(),
                    dsh_home=str(get_config_value(conversation_config, "dsh_home", "") or "").strip(),
                    profile=str(get_config_value(conversation_config, "profile", "sdk") or "sdk").strip(),
                    workspace=str(get_config_value(conversation_config, "workspace", "") or "").strip(),
                    provider=str(
                        get_config_value(
                            conversation_config,
                            "provider",
                            "deepseek-official",
                        )
                        or "deepseek-official"
                    ).strip(),
                    model=str(
                        get_config_value(
                            conversation_config,
                            "model",
                            "deepseek-v4-flash",
                        )
                        or "deepseek-v4-flash"
                    ).strip(),
                    reasoning_effort=(
                        str(
                            get_config_value(conversation_config, "reasoning_effort", "")
                            or ""
                        ).strip()
                        or None
                    ),
                    max_tokens=(
                        int(get_config_value(conversation_config, "max_tokens", 0) or 0)
                        or None
                    ),
                    request_timeout_seconds=(
                        float(
                            get_config_value(
                                conversation_config,
                                "request_timeout_seconds",
                                0.0,
                            )
                            or 0.0
                        )
                        or None
                    ),
                )
            )
        self.turn_coordinator = TurnCoordinator(
            input_preparation=InputPreparation(
                plugin_context=self._plugin_context,
                build_event=lambda: self._build_platform_event(
                    self.message_factory.build_message_object(text="", raw_message={})
                ),
            ),
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
            output_port=self.avatar_output_port,
            build_platform_event=self._build_platform_event,
            commit_event=self.commit_event,
            create_vad_engine=lambda: create_stream_vad_engine(
                engine_type="silero_vad",
                kwargs=self.runtime_state.vad_config,
            ),
            external_conversation_submitter=(
                self._submit_external_conversation
                if self.conversation_platform == "dsh"
                else None
            ),
        )
        self.astrbot_capabilities = AstrBotCapabilityBinding(
            plugin_context=self._plugin_context,
            recognize_audio=self._recognize_provider_audio,
        )
        self.provider_bridge = build_provider_bridge(
            AstrBotProviderBinding(
                callbacks=ProviderBridgeCallbacks(
                    submit_conversation=self._submit_provider_conversation,
                    interrupt_conversation=self._interrupt_provider_conversation,
                    close_conversation=self._close_provider_conversation,
                    recognize_audio=self._recognize_provider_audio,
                    synthesize_tts=self.astrbot_capabilities.synthesize_tts,
                    cancel_tts=self.astrbot_capabilities.cancel_tts,
                    generate_motion=self.astrbot_capabilities.generate_motion,
                    cancel_motion=self.astrbot_capabilities.cancel_motion,
                    send_json=self.transport.send_json,
                ),
                avatar_output=self.avatar_output_port,
            )
        )
        conversation_provider = self.dsh_provider or self.provider_bridge.conversation
        self.interaction_orchestrator = InteractionOrchestrator(
            conversation_provider=conversation_provider,
            stt_provider=self.provider_bridge.stt,
            tts_provider=self.provider_bridge.tts,
            motion_provider=self.provider_bridge.motion,
            output_port=self.avatar_output_port,
            event_sink=self._handle_provider_event,
            active_event_motion_cancel=(
                lambda event, turn_id, reason: self.turn_coordinator._cancel_turn_owned_motion_task(
                    event,
                    turn_id=turn_id,
                    reason=reason,
                )
            ),
        )
        self.interaction_orchestrator.start()
        self.turn_coordinator.attach_interaction_orchestrator(
            self.interaction_orchestrator
        )
        self.interaction_orchestrator.attach_segment_assembler(
            self.turn_coordinator.output_segments
        )
        if self.dsh_provider is not None:
            self.interaction_orchestrator.attach_conversation_event_assembler(
                TextConversationEventAssembler(
                    self.avatar_output_port,
                    publish_segment=self.turn_coordinator.output_segments.publish_external_segment,
                    close_turn=lambda turn_id, reason: self.turn_coordinator.close_turn_output_queue(
                        turn_id=turn_id,
                        failure_reason=reason,
                    ),
                    publish_turn_started=False,
                )
            )
        self.passive_behavior_runtime = PassiveBehaviorRuntime(
            runtime_state=self.runtime_state,
            session_state=self.session_state,
            turn_coordinator=self.turn_coordinator,
            is_desktop_connected=lambda: self.transport._ws_client is not None,
            send_json=self.transport.send_json,
        )
        self.turn_coordinator.set_passive_behavior_interrupt_handler(
            self.passive_behavior_runtime.interrupt_active_request
        )

        logger.debug(
            "AG99live adapter initialized "
            f"(host={self.host}, ws_port={self.port}, http_port={self.http_port})"
        )
        self._refresh_runtime_settings()
        register_control_platform(self.platform_id, self)

    async def _submit_provider_conversation(self, request: ConversationInput) -> None:
        await self.turn_coordinator.submit_provider_message(request)

    async def _submit_external_conversation(self, request: ConversationInput) -> None:
        """Start one DSH request without constructing an AstrBot event."""

        task = asyncio.create_task(
            self.interaction_orchestrator.send_message(request),
            name=f"ag99live-dsh-turn-{request.turn_id[:16]}",
        )
        self._external_conversation_tasks.add(task)

        def _finished(completed: asyncio.Task) -> None:
            self._external_conversation_tasks.discard(completed)
            if completed.cancelled():
                return
            try:
                completed.result()
            except Exception as exc:  # noqa: BLE001 - terminal failure is routed to the turn owner.
                logger.error(
                    "DSH conversation request failed turn_id=%s error=%s",
                    request.turn_id,
                    exc,
                    exc_info=True,
                )
                asyncio.create_task(
                    self.turn_coordinator.abort_turn_from_backend(
                        turn_id=request.turn_id,
                        reason="dsh_conversation_failed",
                    )
                )

        task.add_done_callback(_finished)

    async def _interrupt_provider_conversation(self, turn_id: str | None) -> None:
        normalized_turn_id = str(
            turn_id or self.session_state.current_turn_id or ""
        ).strip()
        if not normalized_turn_id:
            return
        await self.turn_coordinator.abort_turn_from_backend(
            turn_id=normalized_turn_id,
            reason="provider_interrupt",
        )

    async def _close_provider_conversation(self) -> None:
        return None

    @staticmethod
    def _handle_provider_event(event: ProviderEvent) -> None:
        logger.debug(
            "WIRING interaction_orchestrator.provider_event source=%s kind=%s",
            event.source,
            getattr(getattr(event.value, "kind", None), "value", None)
            or getattr(event.value, "kind", None)
            or type(event.value).__name__,
        )

    async def _recognize_provider_audio(
        self,
        stream_id: str,
        pcm_bytes: bytes,
        options,
    ):
        return await self.turn_coordinator.speech_ingress.transcribe_provider_audio(
            stream_id,
            pcm_bytes,
            options,
        )

    def meta(self) -> PlatformMetadata:
        metadata = PlatformMetadata(
            name=ADAPTER_PLATFORM_NAME,
            description=(
                "AG99live 桌宠连接适配器；每个 AstrBot 配置实例对应一个桌宠连接。"
            ),
            id=self.platform_id,
        )
        metadata.adapter_display_name = ADAPTER_DISPLAY_NAME
        # Keep the optional runtime capability available on older metadata constructors.
        metadata.support_personal_runtime = True
        return metadata

    @property
    def model_info(self) -> dict[str, Any]:
        return self.runtime_state.model_info

    @property
    def image_cooldown_seconds(self) -> int:
        return self.runtime_state.image_cooldown_seconds

    async def run(self):
        self._event_loop = asyncio.get_running_loop()
        await self.passive_behavior_runtime.start()
        asr_prewarm_task = asyncio.create_task(
            self.turn_coordinator.speech_ingress.prewarm_streaming_asr(),
            name=f"streaming-asr-prewarm:{self.platform_id}",
        )
        try:
            await self.transport.start()
        except asyncio.CancelledError:
            await self.terminate()
            raise
        except Exception:
            logger.exception("AG99live adapter failed during run()")
            raise
        finally:
            await asyncio.gather(asr_prewarm_task, return_exceptions=True)
            self.desktop_observation.disconnect()
            self.desktop_presence.disconnect()
            await self.interaction_orchestrator.close()
            if self._external_conversation_tasks:
                await asyncio.gather(
                    *tuple(self._external_conversation_tasks),
                    return_exceptions=True,
                )
                self._external_conversation_tasks.clear()
            await self.passive_behavior_runtime.stop()
            unregister_control_platform(self.platform_id, self)
            self._event_loop = None

    async def send_by_session(self, session: MessageSesion, message_chain):
        turn_id = await self.turn_coordinator.begin_proactive_output_turn()
        message_id = f"proactive_reply:{uuid4().hex}"
        try:
            await self.emit_message_chain(
                message_chain=message_chain,
                turn_id=turn_id,
                unified_msg_origin=str(session),
                platform_extras={
                    "logical_message_id": message_id,
                    "logical_segment_index": 0,
                },
            )
            await self.finalize_output_segment(
                turn_id=turn_id,
                message_id=message_id,
            )
            await self.close_turn_output_queue(turn_id=turn_id)
        except asyncio.CancelledError:
            try:
                await self.turn_coordinator.fail_proactive_output_turn(
                    turn_id=turn_id,
                    reason="proactive_output_cancelled",
                )
            except Exception:
                logger.exception(
                    "Failed to publish cancelled proactive output turn: turn_id=%s",
                    turn_id,
                )
            raise
        except Exception:
            try:
                await self.turn_coordinator.fail_proactive_output_turn(
                    turn_id=turn_id,
                    reason="proactive_output_delivery_failed",
                )
            except Exception:
                logger.exception(
                    "Failed to publish failed proactive output turn: turn_id=%s",
                    turn_id,
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
        orchestrator = getattr(self, "interaction_orchestrator", None)
        if orchestrator is not None:
            await orchestrator.emit_message_chain(
                message_chain=message_chain,
                turn_id=turn_id,
                unified_msg_origin=unified_msg_origin,
                raw_reply_text_override=raw_reply_text_override,
                platform_extras=platform_extras,
            )
            return
        await self.turn_coordinator.emit_message_chain(
            message_chain=message_chain,
            turn_id=turn_id,
            unified_msg_origin=unified_msg_origin,
            raw_reply_text_override=raw_reply_text_override,
            platform_extras=platform_extras,
        )

    async def finalize_output_segment(self, *, turn_id: str, message_id: str) -> None:
        orchestrator = getattr(self, "interaction_orchestrator", None)
        if orchestrator is not None:
            await orchestrator.finalize_output_segment(
                turn_id=turn_id,
                message_id=message_id,
            )
            return
        await self.turn_coordinator.finalize_output_segment(
            turn_id=turn_id,
            message_id=message_id,
        )

    async def close_turn_output_queue(
        self,
        *,
        turn_id: str,
        failure_reason: str | None = None,
    ) -> None:
        orchestrator = getattr(self, "interaction_orchestrator", None)
        if orchestrator is not None:
            await orchestrator.close_turn_output_queue(
                turn_id=turn_id,
                failure_reason=failure_reason,
            )
            return
        if failure_reason is None:
            await self.turn_coordinator.close_turn_output_queue(turn_id=turn_id)
        else:
            await self.turn_coordinator.close_turn_output_queue(
                turn_id=turn_id,
                failure_reason=failure_reason,
            )

    def has_pending_persona_segment(self, *, turn_id: str, message_id: str) -> bool:
        orchestrator = getattr(self, "interaction_orchestrator", None)
        if orchestrator is not None:
            return orchestrator.has_pending_persona_segment(
                turn_id=turn_id,
                message_id=message_id,
            )
        return self.turn_coordinator.has_pending_persona_segment(
            turn_id=turn_id,
            message_id=message_id,
        )

    def _refresh_runtime_settings(self) -> None:
        self.runtime_state.refresh()
        self._retain_conversation_platform_until_restart()
        self._sync_client_profile_from_runtime_state()

    async def _refresh_runtime_settings_async(
        self,
        *,
        reload_providers: bool = False,
    ) -> None:
        await self.runtime_state.refresh_async(
            reload_providers=reload_providers,
        )
        self._retain_conversation_platform_until_restart()
        self._sync_client_profile_from_runtime_state()

    async def _synchronize_desktop_settings(self) -> None:
        from .web_control import DESKTOP_SETTINGS_SPEC

        await self.desktop_settings_broker.synchronize_canonical_settings(
            setting.key for setting in DESKTOP_SETTINGS_SPEC
        )

    @staticmethod
    def _is_desktop_setting_key(key: str) -> bool:
        from .web_control import DESKTOP_SETTINGS_SPEC

        return any(setting.key == key for setting in DESKTOP_SETTINGS_SPEC)

    def _retain_conversation_platform_until_restart(self) -> None:
        configured = getattr(self.runtime_state, "conversation_platform", "astrbot")
        if configured == self.conversation_platform:
            return
        logger.warning(
            "Conversation platform setting changed from %s to %s; restart the "
            "AG99live adapter to apply the new provider composition.",
            self.conversation_platform,
            configured,
        )
        self.runtime_state.conversation_platform = self.conversation_platform

    async def _send_current_model_and_conf(self, *, force: bool = False) -> bool:
        payload = self.runtime_state.build_current_model_payload()
        signature = self.runtime_state.build_model_payload_signature(payload)
        if not self.runtime_state.should_send_model_payload(signature, force=force):
            return True

        sent = await self._send_json(payload)
        if not sent:
            logger.warning(
                "Failed to deliver current model payload. "
                "Will retry on next refresh.",
            )
            return False

        self.runtime_state.mark_model_payload_sent(signature)
        return True

    async def _refresh_and_send_current_model_and_conf(self, *, force: bool = False) -> None:
        self._refresh_runtime_settings()
        await self._send_current_model_and_conf(force=force)

    async def _send_motion_tuning_samples_state(self) -> bool:
        payload = build_system_motion_tuning_samples_state(
            samples=self.runtime_state.list_motion_tuning_samples(),
            root_error=self.runtime_state.get_motion_tuning_store_root_error(),
            load_error=self.runtime_state.get_motion_tuning_samples_load_error(),
            diagnostics=self.runtime_state.list_motion_tuning_fewshot_diagnostics(),
            effective_examples=self.runtime_state.list_effective_motion_tuning_examples(),
        )
        return await self._send_json(payload)

    async def open_incremental_output(self, *, event, persona_result_id: str):
        if not self.desktop_audio_credit_enabled:
            raise RuntimeError("incremental_audio_credit_not_negotiated")
        event_context = resolve_adapter_event_context(event)
        orchestrator = getattr(self, "interaction_orchestrator", None)
        if orchestrator is not None:
            return await orchestrator.open_incremental_output(
            turn_id=event_context.delivery_turn_id,
            core_turn_id=event_context.core_turn_id,
            persona_result_id=persona_result_id,
            send_payload=self.transport.bind_current_client_sender(),
            require_turn_active=lambda: self.turn_coordinator.require_incremental_turn_active(
                turn_id=event_context.delivery_turn_id,
                core_turn_id=event_context.core_turn_id,
            ),
            )
        return await self.turn_coordinator.open_incremental_output(
            turn_id=event_context.delivery_turn_id,
            core_turn_id=event_context.core_turn_id,
            persona_result_id=persona_result_id,
            send_payload=self.transport.bind_current_client_sender(),
        )

    async def discard_incremental_output(self, *, event, persona_result_id: str) -> bool:
        event_context = resolve_adapter_event_context(event)
        orchestrator = getattr(self, "interaction_orchestrator", None)
        if orchestrator is not None:
            return await orchestrator.discard_incremental_output(
                turn_id=event_context.delivery_turn_id,
                persona_result_id=persona_result_id,
            )
        return await self.turn_coordinator.discard_incremental_output(
            turn_id=event_context.delivery_turn_id,
            persona_result_id=persona_result_id,
        )

    async def _handle_frontend_system(self, message: Any) -> None:
        # TurnCoordinator hands over a parsed ProtocolMessage, not the raw dict.
        if message.type == "system.desktop_presence_result":
            self.desktop_presence.resolve(message.payload)
            return
        if message.type == "system.desktop_observation_result":
            self.desktop_observation.resolve(message.payload)
            return
        if message.type == TYPE_SYSTEM_DESKTOP_RUNTIME_SETTINGS:
            self.desktop_presence.supported = message.payload.get("desktop_presence_schema") == PRESENCE_SCHEMA
            self.desktop_observation.supported = message.payload.get("desktop_observation_schema") == SCHEMA
            self.desktop_audio_credit_enabled = message.payload.get("audio_credit_schema") == "olv.audio_credit.v1"
            self.desktop_persona_segment_stream_enabled = message.payload[
                "persona_segment_stream_enabled"
            ]
            logger.info(
                "WIRING interaction.desktop_runtime_settings_synced "
                "persona_segment_stream_enabled=%s",
                self.desktop_persona_segment_stream_enabled,
            )
            return
        if message.type == TYPE_SYSTEM_DESKTOP_SETTINGS_RESULT:
            if not self.desktop_settings_broker.resolve(message.payload):
                logger.warning(
                    "Ignoring unsolicited desktop settings result key=%s",
                    message.payload.get("key", ""),
                )
            return
        if message.type == TYPE_SYSTEM_DESKTOP_SETTINGS_UPDATE:
            self.desktop_settings_broker.record_client_update(message.payload)
            return
        await self.frontend_system_handler.handle(
            message,
            send_json=self.transport.bind_current_client_sender(),
            refresh_and_send_model=self._refresh_and_send_current_model_and_conf,
        )

    async def terminate(self) -> None:
        logger.info("AG99live adapter terminate() called")
        try:
            await self.interaction_orchestrator.close()
            await self.passive_behavior_runtime.stop()
            self.desktop_settings_broker.fail_pending("adapter_terminated")
            await self.transport.stop()
        finally:
            unregister_control_platform(self.platform_id, self)
            try:
                motion_lab_recorder = self.runtime_state.motion_lab_recorder
                if motion_lab_recorder is not None:
                    await motion_lab_recorder.close()
            finally:
                self._event_loop = None

    async def _send_json(self, payload: dict[str, Any]) -> bool:
        return await self.transport.send_json(payload)

    async def _handle_transport_disconnect(self) -> None:
        """WebSocket 断开时调用的清理钩子。

        各连接级所有者按固定顺序释放资源；任一所有者失败都必须留下诊断，但不能阻止
        后续所有者清理。全部尝试结束后再把失败汇总交回 transport。
        """
        desktop_observation = getattr(self, "desktop_observation", None)
        if desktop_observation is not None:
            desktop_observation.disconnect()
        desktop_presence = getattr(self, "desktop_presence", None)
        if desktop_presence is not None:
            desktop_presence.disconnect()
        cleanup_failures: list[tuple[str, Exception]] = []
        self.desktop_persona_segment_stream_enabled = False
        self.desktop_audio_credit_enabled = False

        try:
            self.desktop_settings_broker.fail_pending("desktop_client_offline")
        except Exception as exc:
            cleanup_failures.append(("desktop_settings_broker", exc))
            logger.exception("DesktopSettingsBroker disconnect cleanup failed")

        try:
            self.turn_coordinator.reset_turn_tracking()
        except Exception as exc:
            cleanup_failures.append(("turn_coordinator", exc))
            logger.exception("TurnCoordinator disconnect cleanup failed")

        try:
            self.session_state.reset_to_idle()
        except Exception as exc:
            cleanup_failures.append(("session_state", exc))
            logger.exception("SessionState disconnect cleanup failed")

        try:
            self.turn_identity_map.clear_all()
        except Exception as exc:
            cleanup_failures.append(("turn_identity_map", exc))
            logger.exception("TurnIdentityMap disconnect cleanup failed")

        try:
            await self.turn_coordinator.speech_ingress.handle_audio_stream_interrupt()
        except Exception as exc:
            cleanup_failures.append(("speech_ingress", exc))
            logger.exception("SpeechIngress disconnect cleanup failed")

        try:
            await self.media_service.clear_audio_buffer()
        except Exception as exc:
            cleanup_failures.append(("media_service", exc))
            logger.exception("MediaService disconnect cleanup failed")

        if cleanup_failures:
            failed_owners = ",".join(owner for owner, _exc in cleanup_failures)
            raise RuntimeError(
                f"disconnect_cleanup_incomplete:{failed_owners}"
            ) from cleanup_failures[0][1]

    def _sync_client_profile_from_runtime_state(self) -> None:
        self.client_uid = normalize_client_uid(
            self.runtime_state.client_uid,
            DEFAULT_CLIENT_UID,
        )
        self.client_nickname = normalize_client_nickname(
            self.runtime_state.client_nickname,
            DEFAULT_CLIENT_NICKNAME,
        )
        self.session_state.client_uid = self.client_uid
        self.message_factory.set_client_profile(
            self.client_uid,
            self.client_nickname,
        )
        self.history_bridge.set_client_uid(self.client_uid)
