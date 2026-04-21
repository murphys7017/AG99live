from __future__ import annotations

import asyncio
import json
import time
from copy import deepcopy
from typing import Any, Callable

from astrbot.api import logger
from astrbot.api.provider import Provider, STTProvider

from .client_profile import (
    DEFAULT_CLIENT_NICKNAME,
    DEFAULT_CLIENT_UID,
    normalize_client_nickname,
    normalize_client_uid,
)
from .base_action_llm_filter import (
    ACTION_FILTER_SYSTEM_PROMPT,
    ActionFilterDecisionError,
    apply_action_filter_selection,
    build_action_filter_prompt,
    build_action_filter_signature,
    count_selected_channels,
    parse_action_filter_decision,
)
from .live2d_scan import scan_live2d_models
from .payload_builder import build_system_model_sync


class RuntimeState:
    def __init__(
        self,
        *,
        platform_config: Any,
        plugin_context: Any,
        plugin_config: Any,
        plugin_config_loader: Callable[[], Any] | None,
        host: str,
        http_port: int,
        client_uid: str,
        live2ds_dir: Any,
    ) -> None:
        self.platform_config = platform_config
        self.host = host
        self.http_port = http_port
        self.live2ds_dir = live2ds_dir
        self.client_uid = normalize_client_uid(client_uid, DEFAULT_CLIENT_UID)
        self.client_nickname = DEFAULT_CLIENT_NICKNAME

        self.plugin_config = self._clone_plugin_config(plugin_config)
        self.plugin_context = plugin_context
        self.plugin_config_loader = plugin_config_loader

        self.stt_provider_id = ""
        self.motion_analysis_provider_id = ""
        self.enable_action_llm_filter = True
        self.action_llm_filter_timeout_seconds = 12.0
        self.action_llm_filter_min_selected_channels = 3
        self.action_llm_filter_max_atoms_per_channel = 2
        self.vad_model = "silero_vad"
        self.vad_config: dict[str, Any] = {}
        self.model_info: dict[str, Any] = {}
        self.image_cooldown_seconds = 0
        self.default_persona: dict[str, Any] | None = None
        self.selected_stt_provider: STTProvider | None = None
        self.selected_motion_analysis_provider: Provider | None = None
        self._base_action_filter_cache: dict[str, dict[str, Any]] = {}
        self.last_sent_model_signature: str | None = None

    async def load_default_persona(self) -> None:
        if self.plugin_context is None:
            logger.warning("Plugin context is unavailable, skip loading default persona.")
            return

        configured_persona_id = _plugin_config_get(self.plugin_config, "persona_id", "")
        try:
            persona = None
            if configured_persona_id:
                persona = next(
                    (
                        item
                        for item in self.plugin_context.persona_manager.personas_v3
                        if item["name"] == configured_persona_id
                    ),
                    None,
                )
                if persona is None:
                    logger.warning(
                        "Configured persona `%s` not found, fallback to default persona.",
                        configured_persona_id,
                    )

            if persona is None:
                persona = await self.plugin_context.persona_manager.get_default_persona_v3(
                    umo=self.client_uid
                )
        except Exception as exc:
            logger.warning("Failed to load default persona: %s", exc)
            return

        self.default_persona = {
            "name": persona.get("name", "default"),
            "prompt": persona.get("prompt", ""),
            "begin_dialogs": persona.get("begin_dialogs", []),
            "custom_error_message": persona.get("custom_error_message"),
        }
        logger.info("Loaded default persona: %s", self.default_persona["name"])

    def refresh(self) -> bool:
        latest_plugin_config = self._load_latest_plugin_config()
        if latest_plugin_config is not None:
            self.plugin_config = latest_plugin_config

        previous_stt_provider_id = self.stt_provider_id
        previous_motion_analysis_provider_id = self.motion_analysis_provider_id
        previous_vad_model = self.vad_model
        previous_vad_config = dict(self.vad_config)

        self.client_uid = normalize_client_uid(
            _plugin_config_get(self.plugin_config, "client_uid", self.client_uid),
            DEFAULT_CLIENT_UID,
        )
        self.client_nickname = normalize_client_nickname(
            _plugin_config_get(
                self.plugin_config,
                "client_nickname",
                self.client_nickname,
            ),
            DEFAULT_CLIENT_NICKNAME,
        )
        self.stt_provider_id = _plugin_config_get(self.plugin_config, "stt_provider_id", "")
        self.motion_analysis_provider_id = _plugin_config_get(
            self.plugin_config,
            "motion_analysis_provider_id",
            "",
        )
        self.enable_action_llm_filter = bool(
            _plugin_config_get(self.plugin_config, "enable_action_llm_filter", True)
        )
        self.action_llm_filter_timeout_seconds = max(
            float(_plugin_config_get(self.plugin_config, "action_llm_filter_timeout_seconds", 12.0)),
            2.0,
        )
        self.action_llm_filter_min_selected_channels = max(
            int(_plugin_config_get(self.plugin_config, "action_llm_filter_min_selected_channels", 3)),
            1,
        )
        self.action_llm_filter_max_atoms_per_channel = max(
            int(_plugin_config_get(self.plugin_config, "action_llm_filter_max_atoms_per_channel", 2)),
            1,
        )
        self.vad_model = _plugin_config_get(self.plugin_config, "vad_model", "silero_vad")
        self.vad_config = {
            "orig_sr": 16000,
            "target_sr": 16000,
            "prob_threshold": float(
                _plugin_config_get(self.plugin_config, "vad_prob_threshold", 0.4)
            ),
            "db_threshold": int(
                _plugin_config_get(self.plugin_config, "vad_db_threshold", 60)
            ),
            "required_hits": int(
                _plugin_config_get(self.plugin_config, "vad_required_hits", 3)
            ),
            "required_misses": int(
                _plugin_config_get(self.plugin_config, "vad_required_misses", 24)
            ),
            "smoothing_window": int(
                _plugin_config_get(self.plugin_config, "vad_smoothing_window", 5)
            ),
        }
        self.image_cooldown_seconds = max(
            int(_plugin_config_get(self.plugin_config, "image_cooldown_seconds", 0)),
            0,
        )
        self.model_info = scan_live2d_models(
            live2ds_dir=self.live2ds_dir,
            base_url=f"http://{self.host}:{self.http_port}",
            selected_model_name=str(
                _plugin_config_get(self.plugin_config, "live2d_model_name", "")
            ).strip(),
        )

        logger.info(
            "Refreshed adapter runtime settings "
            "(selected_model=%s, available_models=%s)",
            self.model_info.get("selected_model", ""),
            self.model_info.get("available_models", []),
        )

        provider_config_changed = (
            previous_stt_provider_id != self.stt_provider_id
            or previous_motion_analysis_provider_id != self.motion_analysis_provider_id
        )
        provider_binding_missing = (
            (self.stt_provider_id and self.selected_stt_provider is None)
            or (not self.stt_provider_id and self.selected_stt_provider is not None)
            or (
                self.motion_analysis_provider_id
                and self.selected_motion_analysis_provider is None
            )
            or (
                not self.motion_analysis_provider_id
                and self.selected_motion_analysis_provider is not None
            )
        )
        if provider_config_changed or provider_binding_missing:
            logger.info(
                "Provider runtime settings changed, reloading provider bindings "
                "(stt: %s -> %s, motion_analysis: %s -> %s)",
                previous_stt_provider_id or "<default>",
                self.stt_provider_id or "<default>",
                previous_motion_analysis_provider_id or "<default>",
                self.motion_analysis_provider_id or "<default>",
            )
            self.selected_stt_provider = None
            self.selected_motion_analysis_provider = None
            self.load_selected_providers()

        return (
            self.vad_model != previous_vad_model
            or self.vad_config != previous_vad_config
        )

    async def refresh_async(
        self,
        *,
        reload_persona: bool = False,
        reload_providers: bool = False,
    ) -> bool:
        vad_changed = self.refresh()

        if reload_persona:
            await self.load_default_persona()

        if reload_providers:
            self.selected_stt_provider = None
            self.selected_motion_analysis_provider = None
            self.load_selected_providers()

        await self._refresh_base_action_analysis_async()

        return vad_changed

    def load_selected_providers(self) -> None:
        if self.plugin_context is None:
            logger.warning(
                "Plugin context is unavailable, skip loading providers from plugin config."
            )
            return

        if self.stt_provider_id:
            provider = self.plugin_context.get_provider_by_id(self.stt_provider_id)
            if isinstance(provider, STTProvider):
                self.selected_stt_provider = provider
                logger.info("Loaded STT provider from plugin config: %s", self.stt_provider_id)
            else:
                logger.warning(
                    "Configured STT provider `%s` not found or not a STTProvider.",
                    self.stt_provider_id,
                )
        else:
            try:
                provider = self.plugin_context.get_using_stt_provider(umo=self.client_uid)
            except Exception as exc:
                logger.warning("Failed to get current STT provider: %s", exc)
                provider = None
            if isinstance(provider, STTProvider):
                self.selected_stt_provider = provider
                logger.info("Using current STT provider: %s", provider.meta().id)

        if self.motion_analysis_provider_id:
            provider = self.plugin_context.get_provider_by_id(self.motion_analysis_provider_id)
            if isinstance(provider, Provider):
                self.selected_motion_analysis_provider = provider
                logger.info(
                    "Loaded motion analysis provider from plugin config: %s",
                    self.motion_analysis_provider_id,
                )
            else:
                logger.warning(
                    "Configured motion analysis provider `%s` not found or not a chat Provider.",
                    self.motion_analysis_provider_id,
                )
        else:
            try:
                provider = self.plugin_context.get_using_provider(umo=self.client_uid)
            except Exception as exc:
                logger.warning("Failed to get current chat provider: %s", exc)
                provider = None
            if isinstance(provider, Provider):
                self.selected_motion_analysis_provider = provider
                logger.info("Using current chat provider for motion analysis: %s", provider.meta().id)

    def build_current_model_payload(
        self,
        *,
        conf_name: str,
        conf_uid: str,
        client_uid: str,
    ) -> dict[str, Any]:
        return build_system_model_sync(
            session_id=self.client_uid,
            model_info=self.model_info,
            conf_name=conf_name,
            conf_uid=conf_uid,
            client_uid=client_uid,
        )

    def should_send_model_payload(self, payload: dict[str, Any], *, force: bool = False) -> bool:
        signature = json.dumps(payload, sort_keys=True, ensure_ascii=False)
        if force:
            return True
        return signature != self.last_sent_model_signature

    def mark_model_payload_sent(self, payload: dict[str, Any]) -> None:
        self.last_sent_model_signature = json.dumps(
            payload,
            sort_keys=True,
            ensure_ascii=False,
        )

    async def _refresh_base_action_analysis_async(self) -> None:
        models = [
            model
            for model in self.model_info.get("models", [])
            if isinstance(model, dict)
        ]
        if not models:
            return

        if not self.enable_action_llm_filter:
            for model in models:
                self._set_base_action_analysis(
                    model,
                    status="disabled",
                    mode="rule_seed",
                    provider_id="",
                    input_signature="",
                    latency_ms=0,
                    cache_hit=False,
                    error="",
                    fallback_reason="disabled_by_config",
                )
            return

        provider = self.selected_motion_analysis_provider
        provider_id = self._get_provider_id(provider)
        if provider is None:
            for model in models:
                self._set_base_action_analysis(
                    model,
                    status="fallback",
                    mode="rule_seed",
                    provider_id="",
                    input_signature="",
                    latency_ms=0,
                    cache_hit=False,
                    error="",
                    fallback_reason="provider_unavailable",
                )
            return

        for model in models:
            base_action_library = model.get("base_action_library")
            if not isinstance(base_action_library, dict):
                continue

            input_signature = build_action_filter_signature(base_action_library)
            cache_key = (
                f"{provider_id}:{input_signature}:"
                f"{self.action_llm_filter_max_atoms_per_channel}"
            )
            cached_result = self._base_action_filter_cache.get(cache_key)
            if cached_result is not None:
                selected_atom_ids_by_channel = dict(
                    cached_result.get("selected_atom_ids_by_channel") or {}
                )
                selected_channel_count = int(cached_result.get("selected_channel_count") or 0)
                apply_action_filter_selection(
                    base_action_library,
                    selected_atom_ids_by_channel=selected_atom_ids_by_channel,
                    analysis={
                        "status": "filtered",
                        "mode": "llm_strict_cached",
                        "provider_id": provider_id,
                        "input_signature": input_signature,
                        "latency_ms": 0,
                        "cache_hit": True,
                        "selected_channel_count": selected_channel_count,
                        "error": "",
                        "fallback_reason": "",
                    },
                )
                continue

            started_at = time.perf_counter()
            try:
                prompt = build_action_filter_prompt(
                    base_action_library,
                    max_atoms_per_channel=self.action_llm_filter_max_atoms_per_channel,
                )
                response = await asyncio.wait_for(
                    provider.text_chat(
                        prompt=prompt,
                        system_prompt=ACTION_FILTER_SYSTEM_PROMPT,
                    ),
                    timeout=self.action_llm_filter_timeout_seconds,
                )
                completion_text = str(response.completion_text or "").strip()
                if not completion_text:
                    raise ActionFilterDecisionError(
                        "Motion analysis provider returned empty completion_text."
                    )

                selected_atom_ids_by_channel = parse_action_filter_decision(
                    completion_text,
                    base_action_library=base_action_library,
                    max_atoms_per_channel=self.action_llm_filter_max_atoms_per_channel,
                )
                selected_channel_count = count_selected_channels(
                    selected_atom_ids_by_channel
                )
                if selected_channel_count < self.action_llm_filter_min_selected_channels:
                    raise ActionFilterDecisionError(
                        "Selected channels are below configured minimum "
                        f"({selected_channel_count} < {self.action_llm_filter_min_selected_channels})."
                    )

                latency_ms = int((time.perf_counter() - started_at) * 1000)
                apply_action_filter_selection(
                    base_action_library,
                    selected_atom_ids_by_channel=selected_atom_ids_by_channel,
                    analysis={
                        "status": "filtered",
                        "mode": "llm_strict",
                        "provider_id": provider_id,
                        "input_signature": input_signature,
                        "latency_ms": latency_ms,
                        "cache_hit": False,
                        "selected_channel_count": selected_channel_count,
                        "error": "",
                        "fallback_reason": "",
                    },
                )
                self._base_action_filter_cache[cache_key] = {
                    "selected_atom_ids_by_channel": selected_atom_ids_by_channel,
                    "selected_channel_count": selected_channel_count,
                }
            except asyncio.TimeoutError:
                self._set_base_action_analysis(
                    model,
                    status="fallback",
                    mode="rule_seed",
                    provider_id=provider_id,
                    input_signature=input_signature,
                    latency_ms=int((time.perf_counter() - started_at) * 1000),
                    cache_hit=False,
                    error="action_filter_timeout",
                    fallback_reason="timeout",
                )
            except Exception as exc:
                self._set_base_action_analysis(
                    model,
                    status="fallback",
                    mode="rule_seed",
                    provider_id=provider_id,
                    input_signature=input_signature,
                    latency_ms=int((time.perf_counter() - started_at) * 1000),
                    cache_hit=False,
                    error=str(exc),
                    fallback_reason="llm_filter_failed",
                )
                logger.warning(
                    "Failed to apply LLM strict filter for base action library "
                    "(model=%s, provider=%s): %s",
                    model.get("name", "<unknown>"),
                    provider_id or "<default>",
                    exc,
                )

    @staticmethod
    def _get_provider_id(provider: Provider | None) -> str:
        if provider is None:
            return ""
        try:
            meta = provider.meta()
        except Exception:
            return ""
        return str(getattr(meta, "id", "") or "").strip()

    def _set_base_action_analysis(
        self,
        model: dict[str, Any],
        *,
        status: str,
        mode: str,
        provider_id: str,
        input_signature: str,
        latency_ms: int,
        cache_hit: bool,
        error: str,
        fallback_reason: str,
    ) -> None:
        base_action_library = model.get("base_action_library")
        if not isinstance(base_action_library, dict):
            return
        base_action_library["analysis"] = {
            "status": status,
            "mode": mode,
            "provider_id": provider_id,
            "input_signature": input_signature,
            "latency_ms": max(int(latency_ms), 0),
            "cache_hit": bool(cache_hit),
            "selected_channel_count": int(
                base_action_library.get("summary", {}).get("selected_channel_count", 0)
            ),
            "error": error,
            "fallback_reason": fallback_reason,
        }

    @staticmethod
    def _clone_plugin_config(config: Any) -> Any:
        if config is None:
            return {}
        try:
            return deepcopy(config)
        except Exception:
            return config

    def _load_latest_plugin_config(self) -> Any:
        if self.plugin_config_loader is None:
            return self._clone_plugin_config(self.plugin_config)

        try:
            latest_config = self.plugin_config_loader()
        except Exception as exc:
            logger.error("Failed to reload plugin config from plugin runtime: %s", exc)
            raise RuntimeError(f"Failed to reload plugin config from plugin runtime: {exc}") from exc

        if latest_config is None:
            return None

        if not isinstance(latest_config, dict):
            logger.error(
                "Invalid plugin config from plugin runtime: expected a JSON object, got `%s`.",
                type(latest_config).__name__,
            )
            raise RuntimeError("Invalid plugin config from plugin runtime: expected a JSON object.")

        return self._clone_plugin_config(latest_config)


def _plugin_config_get(config: Any, key: str, default: Any) -> Any:
    if config is None:
        return default
    if hasattr(config, "get"):
        value = config.get(key, default)
        return default if value is None else value
    return default
