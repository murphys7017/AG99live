from __future__ import annotations

import asyncio
import json
import time
from copy import deepcopy
from pathlib import Path
from typing import Any, Callable

from astrbot.api import logger
from astrbot.api.provider import Provider, STTProvider

from .client_profile import (
    DEFAULT_CLIENT_NICKNAME,
    DEFAULT_CLIENT_UID,
    normalize_client_nickname,
    normalize_client_uid,
)
from ..motion.action_llm_filter import (
    ACTION_FILTER_SYSTEM_PROMPT,
    ActionFilterDecisionError,
    apply_action_filter_selection,
    build_action_filter_prompt,
    build_action_filter_signature,
    count_selected_channels,
    parse_action_filter_decision,
)
from ..live2d.cache.runtime_cache import (
    build_live2d_directory_md5,
    load_live2d_runtime_cache,
    save_live2d_runtime_cache,
)
from ..live2d.scanner.scan import scan_live2d_models
from ..live2d.semantic_axis_profile import (
    SemanticAxisProfile,
    SemanticAxisProfileError,
    collect_known_parameter_ids,
    ensure_semantic_axis_profile,
    save_semantic_axis_profile,
)
from ..protocol.builder import build_system_model_sync
from ..prompts.motion_selector import DEFAULT_MOTION_PROMPT_INSTRUCTION


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
        runtime_cache_dir: Path | None = None,
    ) -> None:
        self.platform_config = platform_config
        self.host = host
        self.http_port = http_port
        self.live2ds_dir = live2ds_dir
        self.runtime_cache_dir = Path(runtime_cache_dir) if runtime_cache_dir is not None else None
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
        self.action_llm_filter_chunk_max_channels = 8
        self.action_llm_filter_chunk_max_candidates = 96
        self.motion_generation_mode = "split_after_reply"
        self.enable_inline_motion_contract = True
        self.enable_realtime_motion_plan = True
        self.realtime_motion_mode = "realtime"
        self.realtime_motion_timeout_seconds = 8.0
        self.realtime_motion_fewshot_enabled = True
        self.realtime_motion_fewshot_count = 4
        self.motion_tuning_reference_examples: list[dict[str, Any]] = []
        self.motion_tuning_samples: list[dict[str, Any]] = []
        self.realtime_motion_platform_context_enabled = True
        self.realtime_motion_platform_description = ""
        self.motion_prompt_instruction = DEFAULT_MOTION_PROMPT_INSTRUCTION
        self.vad_model = "silero_vad"
        self.vad_config: dict[str, Any] = {}
        self.model_info: dict[str, Any] = {}
        self.image_cooldown_seconds = 0
        self.default_persona: dict[str, Any] | None = None
        self.selected_stt_provider: STTProvider | None = None
        self.selected_motion_analysis_provider: Provider | None = None
        self._live2d_runtime_cache_path = (
            self.runtime_cache_dir / "live2d_runtime_cache.json"
            if self.runtime_cache_dir is not None
            else None
        )
        self._runtime_cache_payload = self._load_runtime_cache_payload()
        self._base_action_filter_cache = self._load_action_filter_cache_from_payload(
            self._runtime_cache_payload
        )
        self.motion_tuning_samples = self._load_motion_tuning_samples_from_payload(
            self._runtime_cache_payload
        )
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
        self.action_llm_filter_chunk_max_channels = max(
            int(_plugin_config_get(self.plugin_config, "action_llm_filter_chunk_max_channels", 8)),
            1,
        )
        self.action_llm_filter_chunk_max_candidates = max(
            int(_plugin_config_get(self.plugin_config, "action_llm_filter_chunk_max_candidates", 96)),
            1,
        )
        self.motion_generation_mode = _normalize_motion_generation_mode(
            _plugin_config_get(
                self.plugin_config,
                "motion_generation_mode",
                "split_after_reply",
            )
        )
        self.enable_inline_motion_contract = bool(
            _plugin_config_get(self.plugin_config, "enable_inline_motion_contract", True)
        )
        self.enable_realtime_motion_plan = bool(
            _plugin_config_get(self.plugin_config, "enable_realtime_motion_plan", True)
        )
        self.realtime_motion_mode = str(
            _plugin_config_get(self.plugin_config, "realtime_motion_mode", "realtime")
        ).strip() or "realtime"
        self.realtime_motion_timeout_seconds = max(
            float(_plugin_config_get(self.plugin_config, "realtime_motion_timeout_seconds", 8.0)),
            1.0,
        )
        self.realtime_motion_fewshot_enabled = bool(
            _plugin_config_get(self.plugin_config, "realtime_motion_fewshot_enabled", True)
        )
        self.realtime_motion_fewshot_count = max(
            0,
            min(
                int(_plugin_config_get(self.plugin_config, "realtime_motion_fewshot_count", 4)),
                8,
            ),
        )
        self.realtime_motion_platform_context_enabled = bool(
            _plugin_config_get(
                self.plugin_config,
                "realtime_motion_platform_context_enabled",
                True,
            )
        )
        self.realtime_motion_platform_description = str(
            _plugin_config_get(
                self.plugin_config,
                "realtime_motion_platform_description",
                "",
            )
            or ""
        ).strip()
        self.motion_prompt_instruction = _normalize_motion_prompt_instruction(
            _plugin_config_get(
                self.plugin_config,
                "motion_prompt_instruction",
                DEFAULT_MOTION_PROMPT_INSTRUCTION,
            )
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
        selected_model_name = str(
            _plugin_config_get(self.plugin_config, "live2d_model_name", "")
        ).strip()
        base_url = f"http://{self.host}:{self.http_port}"
        live2d_dir_md5 = build_live2d_directory_md5(Path(self.live2ds_dir))
        cached_model_info = self._load_model_info_from_scan_cache(
            live2d_dir_md5=live2d_dir_md5,
            base_url=base_url,
            selected_model_name=selected_model_name,
        )
        if cached_model_info is not None:
            self.model_info = cached_model_info
            logger.info(
                "Loaded Live2D scan result from persistent cache "
                "(selected_model=%s, dir_md5=%s)",
                self.model_info.get("selected_model", ""),
                live2d_dir_md5[:12],
            )
        else:
            self.model_info = scan_live2d_models(
                live2ds_dir=self.live2ds_dir,
                base_url=base_url,
                selected_model_name=selected_model_name,
            )
            self._store_model_info_in_scan_cache(
                live2d_dir_md5=live2d_dir_md5,
                base_url=base_url,
                model_info=self.model_info,
            )
        self._attach_semantic_axis_profiles()
        self._refresh_motion_tuning_reference_examples_from_samples()

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

    def save_semantic_axis_profile_update(
        self,
        *,
        model_name: str,
        profile_payload: Any,
        expected_revision: Any,
    ) -> SemanticAxisProfile:
        model = self._get_model_payload_by_name(model_name)
        model_dir = self._resolve_model_dir(model_name)
        if not model.get("semantic_axis_profile"):
            model["semantic_axis_profile"] = deepcopy(
                ensure_semantic_axis_profile(
                    model_dir=model_dir,
                    model_payload=model,
                )
            )

        saved_profile = save_semantic_axis_profile(
            model_dir=model_dir,
            model_name=model_name,
            profile_payload=profile_payload,
            expected_revision=expected_revision,
            known_parameter_ids=collect_known_parameter_ids(model),
        )
        model["semantic_axis_profile"] = deepcopy(saved_profile)
        return saved_profile

    def list_motion_tuning_samples(self) -> list[dict[str, Any]]:
        return deepcopy(self.motion_tuning_samples)

    def save_motion_tuning_sample(self, sample_payload: Any) -> dict[str, Any]:
        normalized_sample = self._normalize_motion_tuning_sample(sample_payload)
        self.motion_tuning_samples = [
            deepcopy(normalized_sample),
            *[
                deepcopy(item)
                for item in self.motion_tuning_samples
                if str(item.get("id") or "").strip() != normalized_sample["id"]
            ],
        ][:200]
        self._runtime_cache_payload["motion_tuning_samples"] = deepcopy(
            self.motion_tuning_samples
        )
        self._persist_runtime_cache_payload()
        self._refresh_motion_tuning_reference_examples_from_samples()
        return deepcopy(normalized_sample)

    def delete_motion_tuning_sample(self, sample_id: Any) -> bool:
        normalized_sample_id = str(sample_id or "").strip()
        if not normalized_sample_id:
            raise ValueError("`sample_id` is required.")
        remaining_samples = [
            deepcopy(item)
            for item in self.motion_tuning_samples
            if str(item.get("id") or "").strip() != normalized_sample_id
        ]
        if len(remaining_samples) == len(self.motion_tuning_samples):
            raise ValueError(f"motion_tuning_sample_not_found: {normalized_sample_id}")
        self.motion_tuning_samples = remaining_samples
        self._runtime_cache_payload["motion_tuning_samples"] = deepcopy(
            self.motion_tuning_samples
        )
        self._persist_runtime_cache_payload()
        self._refresh_motion_tuning_reference_examples_from_samples()
        return True

    def _refresh_motion_tuning_reference_examples_from_samples(self) -> None:
        profile = self._get_selected_semantic_axis_profile()
        if not isinstance(profile, dict):
            self.motion_tuning_reference_examples = []
            return

        profile_id = str(profile.get("profile_id") or "").strip()
        profile_revision = profile.get("revision")
        if not profile_id or not isinstance(profile_revision, int) or profile_revision <= 0:
            self.motion_tuning_reference_examples = []
            return

        normalized_examples: list[dict[str, Any]] = []
        for sample in self.motion_tuning_samples:
            if not isinstance(sample, dict):
                continue
            if not bool(sample.get("enabled_for_llm_reference")):
                continue
            if str(sample.get("profile_id") or "").strip() != profile_id:
                continue
            if int(sample.get("profile_revision") or 0) != profile_revision:
                continue
            adjusted_axes = sample.get("adjusted_axes")
            if not isinstance(adjusted_axes, dict) or not adjusted_axes:
                continue
            adjusted_plan = sample.get("adjusted_plan")
            duration_ms = None
            mode = "expressive"
            if isinstance(adjusted_plan, dict):
                mode = str(adjusted_plan.get("mode") or "expressive").strip() or "expressive"
                timing = adjusted_plan.get("timing")
                if isinstance(timing, dict):
                    duration_ms = timing.get("duration_ms")
            normalized_examples.append(
                {
                    "input": self._build_motion_tuning_sample_input_text(sample),
                    "output": {
                        "emotion": str(sample.get("emotion_label") or "custom").strip() or "custom",
                        "mode": mode,
                        "duration_ms": duration_ms,
                        "axes": {
                            str(axis_id).strip(): value
                            for axis_id, value in adjusted_axes.items()
                            if str(axis_id).strip()
                        },
                    },
                    "source": "desktop_motion_tuning_sample_store",
                    "feedback": str(sample.get("feedback") or "").strip(),
                    "tags": [
                        str(tag).strip()
                        for tag in sample.get("tags", [])
                        if str(tag).strip()
                    ]
                    if isinstance(sample.get("tags"), list)
                    else [],
                }
            )
            if len(normalized_examples) >= 5:
                break
        self.motion_tuning_reference_examples = normalized_examples

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
                f"{self.action_llm_filter_max_atoms_per_channel}:"
                f"{self.action_llm_filter_chunk_max_channels}:"
                f"{self.action_llm_filter_chunk_max_candidates}"
            )
            cached_result = self._base_action_filter_cache.get(cache_key)
            if cached_result is not None:
                selected_atom_ids_by_channel = dict(
                    cached_result.get("selected_atom_ids_by_channel") or {}
                )
                selected_channel_count = int(cached_result.get("selected_channel_count") or 0)
                chunk_count = max(int(cached_result.get("chunk_count") or 1), 1)
                apply_action_filter_selection(
                    base_action_library,
                    selected_atom_ids_by_channel=selected_atom_ids_by_channel,
                    analysis={
                        "status": "filtered",
                        "mode": (
                            "llm_strict_chunked_cached"
                            if chunk_count > 1
                            else "llm_strict_cached"
                        ),
                        "provider_id": provider_id,
                        "input_signature": input_signature,
                        "latency_ms": 0,
                        "cache_hit": True,
                        "chunk_count": chunk_count,
                        "selected_channel_count": selected_channel_count,
                        "error": "",
                        "fallback_reason": "",
                    },
                )
                continue

            started_at = time.perf_counter()
            try:
                chunked_libraries = self._build_action_filter_chunks(base_action_library)
                if not chunked_libraries:
                    raise ActionFilterDecisionError(
                        "No candidate channels available for LLM strict filtering."
                    )

                selected_atom_ids_by_channel: dict[str, list[str]] = {}
                for chunk_library in chunked_libraries:
                    prompt = build_action_filter_prompt(
                        chunk_library,
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

                    selected_chunk = parse_action_filter_decision(
                        completion_text,
                        base_action_library=chunk_library,
                        max_atoms_per_channel=self.action_llm_filter_max_atoms_per_channel,
                    )
                    selected_atom_ids_by_channel = self._merge_selected_atom_ids_by_channel(
                        selected_atom_ids_by_channel,
                        selected_chunk,
                        limit=self.action_llm_filter_max_atoms_per_channel,
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
                        "mode": (
                            "llm_strict_chunked"
                            if len(chunked_libraries) > 1
                            else "llm_strict"
                        ),
                        "provider_id": provider_id,
                        "input_signature": input_signature,
                        "latency_ms": latency_ms,
                        "cache_hit": False,
                        "chunk_count": len(chunked_libraries),
                        "selected_channel_count": selected_channel_count,
                        "error": "",
                        "fallback_reason": "",
                    },
                )
                self._base_action_filter_cache[cache_key] = {
                    "selected_atom_ids_by_channel": selected_atom_ids_by_channel,
                    "selected_channel_count": selected_channel_count,
                    "chunk_count": len(chunked_libraries),
                }
                self._persist_runtime_cache_payload()
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

    def _build_action_filter_chunks(
        self,
        base_action_library: dict[str, Any],
    ) -> list[dict[str, Any]]:
        channels = [
            item
            for item in base_action_library.get("channels", [])
            if isinstance(item, dict)
        ]
        atoms = [
            item
            for item in base_action_library.get("atoms", [])
            if isinstance(item, dict)
        ]
        atom_by_id = {
            str(atom.get("id") or "").strip(): atom
            for atom in atoms
            if str(atom.get("id") or "").strip()
        }
        if not channels or not atom_by_id:
            return []

        max_channels = max(int(self.action_llm_filter_chunk_max_channels), 1)
        max_candidates = max(int(self.action_llm_filter_chunk_max_candidates), 1)

        channel_entries: list[tuple[str, list[str]]] = []
        for channel in channels:
            channel_name = str(channel.get("name") or "").strip()
            if not channel_name:
                continue
            candidate_ids = self._dedupe_preserve_order(
                [
                    str(atom_id).strip()
                    for atom_id in channel.get("atom_ids", [])
                    if str(atom_id).strip() in atom_by_id
                ]
            )
            if not candidate_ids:
                continue
            channel_entries.append((channel_name, candidate_ids))

        if not channel_entries:
            return []

        chunks: list[list[str]] = []
        current_chunk: list[str] = []
        current_candidates = 0

        for channel_name, candidate_ids in channel_entries:
            candidate_count = len(candidate_ids)
            should_split = bool(current_chunk) and (
                len(current_chunk) + 1 > max_channels
                or current_candidates + candidate_count > max_candidates
            )
            if should_split:
                chunks.append(current_chunk)
                current_chunk = []
                current_candidates = 0

            current_chunk.append(channel_name)
            current_candidates += candidate_count

        if current_chunk:
            chunks.append(current_chunk)

        chunk_payloads: list[dict[str, Any]] = []
        for chunk_channel_names in chunks:
            chunk_payload = self._build_action_filter_chunk_payload(
                base_action_library,
                channel_names=chunk_channel_names,
                atom_by_id=atom_by_id,
            )
            if chunk_payload:
                chunk_payloads.append(chunk_payload)

        return chunk_payloads

    def _build_action_filter_chunk_payload(
        self,
        base_action_library: dict[str, Any],
        *,
        channel_names: list[str],
        atom_by_id: dict[str, dict[str, Any]],
    ) -> dict[str, Any]:
        wanted_channels = {str(name).strip() for name in channel_names if str(name).strip()}
        if not wanted_channels:
            return {}

        channels = [
            item
            for item in base_action_library.get("channels", [])
            if isinstance(item, dict)
        ]
        selected_channels: list[dict[str, Any]] = []
        selected_atom_ids: list[str] = []
        selected_atom_id_set: set[str] = set()

        for channel in channels:
            channel_name = str(channel.get("name") or "").strip()
            if channel_name not in wanted_channels:
                continue

            candidate_ids = self._dedupe_preserve_order(
                [
                    str(atom_id).strip()
                    for atom_id in channel.get("atom_ids", [])
                    if str(atom_id).strip() in atom_by_id
                ]
            )
            if not candidate_ids:
                continue

            channel_payload = deepcopy(channel)
            channel_payload["atom_ids"] = candidate_ids
            channel_payload["selected_atom_count"] = len(candidate_ids)
            selected_channels.append(channel_payload)

            for atom_id in candidate_ids:
                if atom_id in selected_atom_id_set:
                    continue
                selected_atom_ids.append(atom_id)
                selected_atom_id_set.add(atom_id)

        if not selected_channels:
            return {}

        selected_atoms = [
            deepcopy(atom_by_id[atom_id])
            for atom_id in selected_atom_ids
            if atom_id in atom_by_id
        ]
        focus_channels = [
            str(channel.get("name") or "").strip()
            for channel in selected_channels
            if str(channel.get("name") or "").strip()
        ]
        focus_domains = sorted(
            {
                str(channel.get("domain") or "").strip()
                for channel in selected_channels
                if str(channel.get("domain") or "").strip()
            }
        )

        return {
            "schema_version": base_action_library.get("schema_version", ""),
            "focus_channels": focus_channels,
            "focus_domains": focus_domains,
            "channels": selected_channels,
            "atoms": selected_atoms,
        }

    @staticmethod
    def _merge_selected_atom_ids_by_channel(
        left: dict[str, list[str]],
        right: dict[str, list[str]],
        *,
        limit: int,
    ) -> dict[str, list[str]]:
        merged: dict[str, list[str]] = {}
        safe_limit = max(int(limit), 1)
        all_channel_names = set(left.keys()) | set(right.keys())

        for channel_name in all_channel_names:
            channel = str(channel_name or "").strip()
            if not channel:
                continue
            values = list(left.get(channel, [])) + list(right.get(channel, []))
            merged[channel] = RuntimeState._dedupe_preserve_order(values)[:safe_limit]

        return merged

    @staticmethod
    def _dedupe_preserve_order(values: list[str]) -> list[str]:
        result: list[str] = []
        seen: set[str] = set()
        for value in values:
            normalized = str(value or "").strip()
            if not normalized or normalized in seen:
                continue
            seen.add(normalized)
            result.append(normalized)
        return result

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

    def _load_runtime_cache_payload(self) -> dict[str, Any]:
        if self._live2d_runtime_cache_path is None:
            return {"scan_cache": {}, "action_filter_cache": {}}
        return load_live2d_runtime_cache(self._live2d_runtime_cache_path)

    @staticmethod
    def _load_action_filter_cache_from_payload(payload: dict[str, Any]) -> dict[str, dict[str, Any]]:
        raw_cache = payload.get("action_filter_cache")
        if not isinstance(raw_cache, dict):
            return {}

        normalized_cache: dict[str, dict[str, Any]] = {}
        for cache_key, cache_value in raw_cache.items():
            if not isinstance(cache_key, str) or not isinstance(cache_value, dict):
                continue
            selected_atom_ids_by_channel_raw = cache_value.get("selected_atom_ids_by_channel")
            if not isinstance(selected_atom_ids_by_channel_raw, dict):
                continue

            selected_atom_ids_by_channel: dict[str, list[str]] = {}
            for channel_name, atom_ids in selected_atom_ids_by_channel_raw.items():
                if not isinstance(channel_name, str) or not isinstance(atom_ids, list):
                    continue
                selected_atom_ids_by_channel[channel_name] = [
                    str(atom_id).strip()
                    for atom_id in atom_ids
                    if str(atom_id).strip()
                ]

            normalized_cache[cache_key] = {
                "selected_atom_ids_by_channel": selected_atom_ids_by_channel,
                "selected_channel_count": max(int(cache_value.get("selected_channel_count") or 0), 0),
                "chunk_count": max(int(cache_value.get("chunk_count") or 1), 1),
            }

        return normalized_cache

    def _load_model_info_from_scan_cache(
        self,
        *,
        live2d_dir_md5: str,
        base_url: str,
        selected_model_name: str,
    ) -> dict[str, Any] | None:
        scan_cache = self._runtime_cache_payload.get("scan_cache")
        if not isinstance(scan_cache, dict):
            return None

        cached_md5 = str(scan_cache.get("live2d_dir_md5") or "").strip()
        cached_base_url = str(scan_cache.get("base_url") or "").strip()
        if not cached_md5 or cached_md5 != live2d_dir_md5:
            self._clear_persistent_caches(reset_scan_cache=True)
            return None
        if cached_base_url != base_url:
            return None

        model_info = scan_cache.get("model_info")
        if not isinstance(model_info, dict):
            return None

        result = deepcopy(model_info)
        models = [
            model
            for model in result.get("models", [])
            if isinstance(model, dict) and str(model.get("name") or "").strip()
        ]
        if not models:
            return result

        available_models = [
            str(model.get("name") or "").strip()
            for model in models
            if str(model.get("name") or "").strip()
        ]
        selected_model = selected_model_name if selected_model_name in available_models else available_models[0]
        result["selected_model"] = selected_model
        result["available_models"] = available_models
        return result

    def _store_model_info_in_scan_cache(
        self,
        *,
        live2d_dir_md5: str,
        base_url: str,
        model_info: dict[str, Any],
    ) -> None:
        self._runtime_cache_payload["scan_cache"] = {
            "live2d_dir_md5": live2d_dir_md5,
            "base_url": base_url,
            "model_info": deepcopy(model_info),
        }
        self._persist_runtime_cache_payload()

    def _clear_persistent_caches(self, *, reset_scan_cache: bool) -> None:
        if reset_scan_cache:
            self._runtime_cache_payload["scan_cache"] = {}
        self._runtime_cache_payload["action_filter_cache"] = {}
        self._base_action_filter_cache = {}
        self._persist_runtime_cache_payload()

    def _attach_semantic_axis_profiles(self) -> None:
        models = self.model_info.get("models", [])
        if not isinstance(models, list):
            return
        for model in models:
            if not isinstance(model, dict):
                continue
            model_name = str(model.get("name") or "").strip()
            if not model_name:
                continue
            profile = ensure_semantic_axis_profile(
                model_dir=self._resolve_model_dir(model_name),
                model_payload=model,
            )
            model["semantic_axis_profile"] = deepcopy(profile)

    def _get_model_payload_by_name(self, model_name: str) -> dict[str, Any]:
        normalized_name = str(model_name or "").strip()
        if not normalized_name:
            raise SemanticAxisProfileError("`model_name` is required.")
        for model in self.model_info.get("models", []):
            if not isinstance(model, dict):
                continue
            if str(model.get("name") or "").strip() == normalized_name:
                return model
        raise SemanticAxisProfileError(f"Unknown Live2D model: `{normalized_name}`.")

    def _resolve_model_dir(self, model_name: str) -> Path:
        normalized_name = str(model_name or "").strip()
        if not normalized_name:
            raise SemanticAxisProfileError("`model_name` is required.")
        return Path(self.live2ds_dir) / normalized_name

    def _get_selected_semantic_axis_profile(self) -> dict[str, Any] | None:
        selected_model_name = str(self.model_info.get("selected_model") or "").strip()
        if not selected_model_name:
            return None
        for model in self.model_info.get("models", []):
            if not isinstance(model, dict):
                continue
            if str(model.get("name") or "").strip() != selected_model_name:
                continue
            profile = model.get("semantic_axis_profile")
            if isinstance(profile, dict):
                return profile
            return None
        return None

    def _persist_runtime_cache_payload(self) -> None:
        self._runtime_cache_payload["action_filter_cache"] = deepcopy(self._base_action_filter_cache)
        self._runtime_cache_payload["motion_tuning_samples"] = deepcopy(
            self.motion_tuning_samples
        )
        if self._live2d_runtime_cache_path is None:
            return
        save_live2d_runtime_cache(self._live2d_runtime_cache_path, self._runtime_cache_payload)

    def _load_motion_tuning_samples_from_payload(
        self,
        payload: dict[str, Any],
    ) -> list[dict[str, Any]]:
        raw_samples = payload.get("motion_tuning_samples")
        if not isinstance(raw_samples, list):
            return []

        normalized_samples: list[dict[str, Any]] = []
        for sample in raw_samples:
            try:
                normalized_samples.append(self._normalize_motion_tuning_sample(sample))
            except ValueError as exc:
                logger.warning("Ignoring invalid persisted motion tuning sample: %s", exc)
        return normalized_samples[:200]

    def _normalize_motion_tuning_sample(self, sample_payload: Any) -> dict[str, Any]:
        if not isinstance(sample_payload, dict):
            raise ValueError("motion_tuning_sample_not_object")

        sample_id = str(sample_payload.get("id") or "").strip()
        if not sample_id:
            raise ValueError("motion_tuning_sample_id_required")

        created_at = str(sample_payload.get("created_at") or "").strip()
        if not created_at:
            raise ValueError("motion_tuning_sample_created_at_required")

        source_record_id = str(sample_payload.get("source_record_id") or "").strip()
        if not source_record_id:
            raise ValueError("motion_tuning_sample_source_record_id_required")

        model_name = str(sample_payload.get("model_name") or "").strip()
        if not model_name:
            raise ValueError("motion_tuning_sample_model_name_required")

        profile_id = str(sample_payload.get("profile_id") or "").strip()
        if not profile_id:
            raise ValueError("motion_tuning_sample_profile_id_required")

        profile_revision_raw = sample_payload.get("profile_revision")
        if isinstance(profile_revision_raw, bool):
            raise ValueError("motion_tuning_sample_profile_revision_invalid")
        try:
            profile_revision = int(profile_revision_raw)
        except (TypeError, ValueError):
            raise ValueError("motion_tuning_sample_profile_revision_invalid") from None
        if profile_revision <= 0:
            raise ValueError("motion_tuning_sample_profile_revision_invalid")

        adjusted_axes = self._normalize_motion_tuning_axes(
            sample_payload.get("adjusted_axes"),
            field_name="adjusted_axes",
            require_non_empty=True,
        )
        original_axes = self._normalize_motion_tuning_axes(
            sample_payload.get("original_axes"),
            field_name="original_axes",
            require_non_empty=False,
        )
        adjusted_plan = self._normalize_motion_tuning_adjusted_plan(
            sample_payload.get("adjusted_plan"),
            model_name=model_name,
            profile_id=profile_id,
            profile_revision=profile_revision,
        )

        tags = self._normalize_motion_tuning_tags(sample_payload.get("tags"))
        emotion_label = str(sample_payload.get("emotion_label") or "").strip() or "manual_tuning"

        return {
            "id": sample_id,
            "created_at": created_at,
            "source_record_id": source_record_id,
            "model_name": model_name,
            "profile_id": profile_id,
            "profile_revision": profile_revision,
            "emotion_label": emotion_label,
            "assistant_text": str(sample_payload.get("assistant_text") or "").strip(),
            "feedback": str(sample_payload.get("feedback") or "").strip(),
            "tags": tags,
            "enabled_for_llm_reference": bool(
                sample_payload.get("enabled_for_llm_reference")
            ),
            "original_axes": original_axes,
            "adjusted_axes": adjusted_axes,
            "adjusted_plan": adjusted_plan,
        }

    def _normalize_motion_tuning_adjusted_plan(
        self,
        plan_payload: Any,
        *,
        model_name: str,
        profile_id: str,
        profile_revision: int,
    ) -> dict[str, Any]:
        if not isinstance(plan_payload, dict):
            raise ValueError("motion_tuning_sample_adjusted_plan_not_object")
        if str(plan_payload.get("schema_version") or "").strip() != "engine.parameter_plan.v2":
            raise ValueError("motion_tuning_sample_adjusted_plan_schema_invalid")
        if str(plan_payload.get("model_id") or "").strip() != model_name:
            raise ValueError("motion_tuning_sample_adjusted_plan_model_mismatch")
        if str(plan_payload.get("profile_id") or "").strip() != profile_id:
            raise ValueError("motion_tuning_sample_adjusted_plan_profile_mismatch")

        plan_profile_revision_raw = plan_payload.get("profile_revision")
        if isinstance(plan_profile_revision_raw, bool):
            raise ValueError("motion_tuning_sample_adjusted_plan_revision_invalid")
        try:
            plan_profile_revision = int(plan_profile_revision_raw)
        except (TypeError, ValueError):
            raise ValueError("motion_tuning_sample_adjusted_plan_revision_invalid") from None
        if plan_profile_revision != profile_revision:
            raise ValueError("motion_tuning_sample_adjusted_plan_revision_mismatch")

        mode = str(plan_payload.get("mode") or "").strip()
        if mode not in {"idle", "expressive"}:
            raise ValueError("motion_tuning_sample_adjusted_plan_mode_invalid")

        emotion_label = str(plan_payload.get("emotion_label") or "").strip() or "manual_tuning"
        timing_payload = plan_payload.get("timing")
        if not isinstance(timing_payload, dict):
            raise ValueError("motion_tuning_sample_adjusted_plan_timing_invalid")

        timing: dict[str, int] = {}
        for key in ("duration_ms", "blend_in_ms", "hold_ms", "blend_out_ms"):
            raw_value = timing_payload.get(key)
            if isinstance(raw_value, bool):
                raise ValueError(f"motion_tuning_sample_adjusted_plan_{key}_invalid")
            try:
                normalized_value = int(raw_value)
            except (TypeError, ValueError):
                raise ValueError(
                    f"motion_tuning_sample_adjusted_plan_{key}_invalid"
                ) from None
            if normalized_value < 0:
                raise ValueError(f"motion_tuning_sample_adjusted_plan_{key}_invalid")
            timing[key] = normalized_value

        raw_parameters = plan_payload.get("parameters")
        if not isinstance(raw_parameters, list) or not raw_parameters:
            raise ValueError("motion_tuning_sample_adjusted_plan_parameters_invalid")

        parameters: list[dict[str, Any]] = []
        for parameter in raw_parameters:
            if not isinstance(parameter, dict):
                raise ValueError("motion_tuning_sample_adjusted_plan_parameter_not_object")
            axis_id = str(parameter.get("axis_id") or "").strip()
            parameter_id = str(parameter.get("parameter_id") or "").strip()
            target_value = _coerce_finite_number(parameter.get("target_value"))
            weight = _coerce_finite_number(parameter.get("weight"))
            if (
                not axis_id
                or not parameter_id
                or target_value is None
                or weight is None
                or weight < 0
                or weight > 1
            ):
                raise ValueError("motion_tuning_sample_adjusted_plan_parameter_invalid")
            input_value_raw = parameter.get("input_value")
            input_value = _coerce_finite_number(input_value_raw)
            if input_value_raw is not None and input_value is None:
                raise ValueError("motion_tuning_sample_adjusted_plan_input_value_invalid")
            source = str(parameter.get("source") or "").strip()
            normalized_parameter = {
                "axis_id": axis_id,
                "parameter_id": parameter_id,
                "target_value": target_value,
                "weight": weight,
            }
            if input_value is not None:
                normalized_parameter["input_value"] = input_value
            if source in {"semantic_axis", "coupling", "manual"}:
                normalized_parameter["source"] = source
            parameters.append(normalized_parameter)

        normalized_plan: dict[str, Any] = {
            "schema_version": "engine.parameter_plan.v2",
            "profile_id": profile_id,
            "profile_revision": profile_revision,
            "model_id": model_name,
            "mode": mode,
            "emotion_label": emotion_label,
            "timing": timing,
            "parameters": parameters,
        }
        diagnostics = plan_payload.get("diagnostics")
        if isinstance(diagnostics, dict):
            warnings = diagnostics.get("warnings")
            normalized_diagnostics: dict[str, Any] = {}
            if isinstance(warnings, list):
                normalized_diagnostics["warnings"] = [
                    str(item).strip() for item in warnings if str(item).strip()
                ]
            if normalized_diagnostics:
                normalized_plan["diagnostics"] = normalized_diagnostics
        summary = plan_payload.get("summary")
        if isinstance(summary, dict):
            normalized_summary: dict[str, Any] = {}
            for key in ("axis_count", "parameter_count", "target_duration_ms"):
                raw_value = summary.get(key)
                if isinstance(raw_value, bool):
                    continue
                try:
                    normalized_value = int(raw_value)
                except (TypeError, ValueError):
                    continue
                normalized_summary[key] = normalized_value
            if normalized_summary:
                normalized_plan["summary"] = normalized_summary
        return normalized_plan

    @staticmethod
    def _normalize_motion_tuning_axes(
        axes_payload: Any,
        *,
        field_name: str,
        require_non_empty: bool,
    ) -> dict[str, float]:
        if not isinstance(axes_payload, dict):
            raise ValueError(f"motion_tuning_sample_{field_name}_not_object")
        result: dict[str, float] = {}
        for axis_id, raw_value in axes_payload.items():
            normalized_axis_id = str(axis_id or "").strip()
            normalized_value = _coerce_finite_number(raw_value)
            if not normalized_axis_id or normalized_value is None:
                continue
            result[normalized_axis_id] = normalized_value
        if require_non_empty and not result:
            raise ValueError(f"motion_tuning_sample_{field_name}_empty")
        return result

    @staticmethod
    def _normalize_motion_tuning_tags(tags_payload: Any) -> list[str]:
        if not isinstance(tags_payload, list):
            return []
        result: list[str] = []
        seen: set[str] = set()
        for tag in tags_payload:
            normalized_tag = str(tag or "").strip()
            if not normalized_tag or normalized_tag in seen:
                continue
            seen.add(normalized_tag)
            result.append(normalized_tag)
        return result

    @staticmethod
    def _build_motion_tuning_sample_input_text(sample: dict[str, Any]) -> str:
        lines: list[str] = []
        assistant_text = str(sample.get("assistant_text") or "").strip()
        feedback = str(sample.get("feedback") or "").strip()
        tags = sample.get("tags")
        if assistant_text:
            lines.append(f"Assistant: {assistant_text}")
        if feedback:
            lines.append(f"Tuning note: {feedback}")
        if isinstance(tags, list):
            normalized_tags = [str(tag).strip() for tag in tags if str(tag).strip()]
            if normalized_tags:
                lines.append(f"Tags: {', '.join(normalized_tags)}")
        return "\n".join(lines)

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


def _normalize_motion_prompt_instruction(value: Any) -> str:
    text = str(value or "").strip()
    if not text:
        return DEFAULT_MOTION_PROMPT_INSTRUCTION
    if len(text) > 800:
        return text[:800].rstrip()
    return text


def _normalize_motion_generation_mode(value: Any) -> str:
    mode = str(value or "").strip()
    if mode in {"inline_first", "split_after_reply", "text_only"}:
        return mode
    return "split_after_reply"


def _coerce_finite_number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        if value != value or value in {float("inf"), float("-inf")}:
            return None
        return float(value)
    return None
