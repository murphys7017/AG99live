from __future__ import annotations

import hashlib
import json
from copy import deepcopy
from pathlib import Path
from typing import Any, Callable

from astrbot.api import logger
from astrbot.api.provider import Provider, STTProvider

from ..core_compatibility import supports_interaction_contributors
from .client_profile import (
    DEFAULT_CLIENT_NICKNAME,
    DEFAULT_CLIENT_UID,
    normalize_client_nickname,
    normalize_client_uid,
)
from ..motion.performance_curve import PerformanceCurveRuntime
from ..prompts.motion_selector import (
    MotionReferenceExamplesResolution,
    resolve_motion_reference_examples,
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
    collect_bindable_parameter_ids,
    ensure_semantic_axis_profile,
    save_semantic_axis_profile,
)
from ..protocol.builder import build_system_model_sync
from ..protocol.schema_versions import MODEL_INFO_SCHEMA_VERSION
from .motion_state import MotionTuningStore
from .motion_lab import MotionLabRawEventStore, MotionLabRecorder

LIVE2D_SCAN_CACHE_VERSION = "live2d_scan_cache.v3"


class RuntimeStateConfigurationError(RuntimeError):
    """Raised when an explicitly enabled runtime capability is misconfigured."""


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
        state_dir: Path | None = None,
    ) -> None:
        self.platform_config = platform_config
        self.host = host
        self.http_port = http_port
        self.live2ds_dir = live2ds_dir
        self.runtime_cache_dir = Path(runtime_cache_dir) if runtime_cache_dir is not None else None
        self.state_dir = Path(state_dir) if state_dir is not None else None
        self.client_uid = normalize_client_uid(client_uid, DEFAULT_CLIENT_UID)
        self.client_nickname = DEFAULT_CLIENT_NICKNAME

        self.plugin_config = self._clone_plugin_config(plugin_config)
        self.plugin_context = plugin_context
        self.plugin_config_loader = plugin_config_loader

        self.stt_provider_id = ""
        self.performance_curve_provider_id = ""
        self.enable_performance_curve = False
        self.interaction_contributors_available = supports_interaction_contributors(
            plugin_context
        )
        self.ag99live_motion_persona_effect_available = (
            self.interaction_contributors_available
        )
        self.motion_tuning_fewshot_enabled = True
        self.motion_tuning_fewshot_count = 7
        self.motion_tuning_user_fewshot_count = 3
        self.runtime_cache_root_error = ""
        self.runtime_cache_segment_errors: dict[str, str] = {}
        self._motion_tuning_store = MotionTuningStore(
            storage_path=(
                self.state_dir / "motion_tuning_samples.json"
                if self.state_dir is not None
                else None
            ),
            get_selected_profile=self._get_selected_semantic_axis_profile,
            get_turn_context=self._get_motion_lab_turn_context,
        )
        self.motion_lab_recorder = self._build_motion_lab_recorder()
        self.vad_model = "silero_vad"
        self.vad_config: dict[str, Any] = {}
        self.model_info: dict[str, Any] = {}
        self.image_cooldown_seconds = 0
        self.selected_stt_provider: STTProvider | None = None
        self.selected_performance_curve_provider: Provider | None = None
        self.performance_curve_runtime = PerformanceCurveRuntime(runtime_state=self)
        self._live2d_runtime_cache_path = (
            self.runtime_cache_dir / "live2d_runtime_cache.json"
            if self.runtime_cache_dir is not None
            else None
        )
        self._runtime_cache_payload = self._load_runtime_cache_payload()
        self._motion_tuning_store.load()
        self.last_sent_model_signature: str | None = None

    def _build_motion_lab_recorder(self) -> MotionLabRecorder | None:
        if self.state_dir is None:
            return None
        return MotionLabRecorder(
            store=MotionLabRawEventStore(self.state_dir / "motion_lab.sqlite3"),
            batch_size=20,
        )

    def _get_motion_lab_turn_context(
        self,
        turn_id: str,
        message_id: str,
    ) -> dict[str, str] | None:
        recorder = self.motion_lab_recorder
        if recorder is None:
            return None
        return recorder.get_turn_context(
            turn_id=turn_id,
            message_id=message_id,
        )

    def refresh(self) -> bool:
        latest_plugin_config = self._load_latest_plugin_config()
        if latest_plugin_config is not None:
            self.plugin_config = latest_plugin_config

        previous_stt_provider_id = self.stt_provider_id
        previous_performance_curve_provider_id = self.performance_curve_provider_id
        previous_enable_performance_curve = self.enable_performance_curve
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
        self.performance_curve_provider_id = _plugin_config_get(
            self.plugin_config,
            "performance_curve_provider_id",
            "",
        )
        self.enable_performance_curve = bool(
            _plugin_config_get(self.plugin_config, "enable_performance_curve", False)
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
            or previous_performance_curve_provider_id != self.performance_curve_provider_id
            or previous_enable_performance_curve != self.enable_performance_curve
        )
        provider_binding_missing = (
            (self.stt_provider_id and self.selected_stt_provider is None)
            or (not self.stt_provider_id and self.selected_stt_provider is not None)
            or (
                self.enable_performance_curve
                and self.selected_performance_curve_provider is None
            )
            or (
                not self.enable_performance_curve
                and self.selected_performance_curve_provider is not None
            )
        )
        if provider_config_changed or provider_binding_missing:
            logger.info(
                "Provider runtime settings changed, reloading provider bindings "
                "(stt: %s -> %s, performance_curve: %s -> %s, performance_curve_enabled: %s -> %s)",
                previous_stt_provider_id or "<default>",
                self.stt_provider_id or "<default>",
                previous_performance_curve_provider_id or "<default>",
                self.performance_curve_provider_id or "<default>",
                previous_enable_performance_curve,
                self.enable_performance_curve,
            )
            self.selected_stt_provider = None
            self.selected_performance_curve_provider = None
            self.load_selected_providers()

        return (
            self.vad_model != previous_vad_model
            or self.vad_config != previous_vad_config
        )

    async def refresh_async(
        self,
        *,
        reload_providers: bool = False,
    ) -> bool:
        vad_changed = self.refresh()

        if reload_providers:
            self.selected_stt_provider = None
            self.selected_performance_curve_provider = None
            self.load_selected_providers()

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

        if self.enable_performance_curve:
            if not self.performance_curve_provider_id:
                raise RuntimeStateConfigurationError(
                    "Performance curve generation is enabled but "
                    "`performance_curve_provider_id` is empty."
                )
            provider = self.plugin_context.get_provider_by_id(
                self.performance_curve_provider_id
            )
            if not isinstance(provider, Provider):
                raise RuntimeStateConfigurationError(
                    "Configured performance curve provider "
                    f"`{self.performance_curve_provider_id}` was not found or is not a chat Provider."
                )
            self.selected_performance_curve_provider = provider
            logger.info(
                "Loaded performance curve provider from plugin config: %s",
                self.performance_curve_provider_id,
            )

    def build_current_model_payload(
        self,
        *,
        conf_name: str,
        conf_uid: str,
        client_uid: str,
    ) -> dict[str, Any]:
        runtime_cache_errors = self._build_runtime_cache_error_payload()
        model_info_payload = _project_frontend_model_info(self.model_info)
        return build_system_model_sync(
            model_info=model_info_payload,
            runtime_cache_errors=runtime_cache_errors,
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
            bindable_parameter_ids=collect_bindable_parameter_ids(model),
        )
        model["semantic_axis_profile"] = deepcopy(saved_profile)
        self._refresh_motion_tuning_reference_examples_from_samples()
        return saved_profile

    def list_motion_tuning_samples(self) -> list[dict[str, Any]]:
        return self._motion_tuning_store.list_samples()

    def get_motion_tuning_samples_load_error(self) -> str:
        return self._motion_tuning_store.samples_load_error

    def get_motion_tuning_store_root_error(self) -> str:
        return "" if self.state_dir is not None else "motion_tuning_store_path_unavailable"

    def get_runtime_cache_root_error(self) -> str:
        return self.runtime_cache_root_error

    def list_runtime_cache_segment_errors(self) -> dict[str, str]:
        return dict(self.runtime_cache_segment_errors)

    def list_motion_tuning_fewshot_diagnostics(self) -> list[str]:
        resolution = self._resolve_motion_reference_examples()
        return [
            *self._motion_tuning_store.list_fewshot_diagnostics(),
            *resolution["diagnostics"],
        ]

    def list_effective_motion_tuning_examples(self) -> list[dict[str, Any]]:
        return self._resolve_motion_reference_examples()["examples"]

    def list_motion_tuning_reference_examples(self) -> list[dict[str, Any]]:
        return self._motion_tuning_store.list_reference_examples()

    def save_motion_tuning_sample(self, sample_payload: Any) -> dict[str, Any]:
        return self._motion_tuning_store.save_sample(sample_payload)

    def delete_motion_tuning_sample(self, sample_id: Any) -> bool:
        return self._motion_tuning_store.delete_sample(sample_id)

    def _refresh_motion_tuning_reference_examples_from_samples(self) -> None:
        self._motion_tuning_store.refresh_reference_examples()

    def _resolve_motion_reference_examples(
        self,
        request_text: str = "",
    ) -> MotionReferenceExamplesResolution:
        return resolve_motion_reference_examples(
            runtime_state=self,
            request_text=request_text,
        )

    def should_send_model_payload(self, signature: str, *, force: bool = False) -> bool:
        if force:
            return True
        return signature != self.last_sent_model_signature

    def build_model_payload_signature(self, payload: dict[str, Any]) -> str:
        encoded = json.dumps(
            payload,
            sort_keys=True,
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
        return hashlib.sha256(encoded).hexdigest()

    def mark_model_payload_sent(self, signature: str) -> None:
        self.last_sent_model_signature = signature

    def _load_runtime_cache_payload(self) -> dict[str, Any]:
        if self._live2d_runtime_cache_path is None:
            return {"scan_cache": {}}
        payload, load_errors = load_live2d_runtime_cache(self._live2d_runtime_cache_path)
        self.runtime_cache_root_error = str(load_errors.get("root") or "").strip()
        self.runtime_cache_segment_errors = {
            key: str(value).strip()
            for key, value in load_errors.items()
            if key != "root" and str(value).strip()
        }
        return payload

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

        cache_version = str(scan_cache.get("cache_version") or "").strip()
        if cache_version != LIVE2D_SCAN_CACHE_VERSION:
            self._clear_persistent_caches(reset_scan_cache=True)
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
        if (
            str(model_info.get("schema_version") or "").strip()
            != MODEL_INFO_SCHEMA_VERSION
        ):
            self._clear_persistent_caches(reset_scan_cache=True)
            return None

        result = deepcopy(model_info)
        models = [
            model
            for model in result.get("models", [])
            if isinstance(model, dict) and str(model.get("name") or "").strip()
        ]
        if not models:
            return None if selected_model_name else result

        available_models = [
            str(model.get("name") or "").strip()
            for model in models
            if str(model.get("name") or "").strip()
        ]
        if selected_model_name and selected_model_name not in available_models:
            return None
        selected_model = selected_model_name or available_models[0]
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
            "cache_version": LIVE2D_SCAN_CACHE_VERSION,
            "live2d_dir_md5": live2d_dir_md5,
            "base_url": base_url,
            "model_info": deepcopy(model_info),
        }
        self._persist_runtime_cache_payload()

    def _clear_persistent_caches(self, *, reset_scan_cache: bool) -> None:
        if reset_scan_cache:
            self._runtime_cache_payload["scan_cache"] = {}
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

    def _persist_runtime_cache_payload(self) -> None:
        if self.runtime_cache_root_error:
            logger.warning(
                "Skip persisting runtime cache while root cache error is active: %s",
                self.runtime_cache_root_error,
            )
            return
        if self.runtime_cache_segment_errors:
            logger.warning(
                "Skip persisting runtime cache while segment cache errors are active: %s",
                self.runtime_cache_segment_errors,
            )
            return
        if self._live2d_runtime_cache_path is None:
            return
        save_live2d_runtime_cache(self._live2d_runtime_cache_path, self._runtime_cache_payload)

    def _build_runtime_cache_error_payload(self) -> dict[str, str]:
        payload = {
            key: value
            for key, value in self.runtime_cache_segment_errors.items()
            if str(key).strip() and str(value).strip()
        }
        if self.runtime_cache_root_error:
            payload["root"] = self.runtime_cache_root_error
        return payload

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


def _project_frontend_model_info(model_info: dict[str, Any]) -> dict[str, Any]:
    root_fields = (
        "schema_version",
        "driver_priority",
        "selected_model",
        "available_models",
    )
    missing_root_fields = [field for field in root_fields if field not in model_info]
    if missing_root_fields:
        raise RuntimeError(
            "live2d_frontend_model_info_projection_missing_fields:"
            + ",".join(missing_root_fields)
        )
    schema_version = str(model_info["schema_version"] or "").strip()
    if schema_version != MODEL_INFO_SCHEMA_VERSION:
        raise RuntimeError(
            "live2d_frontend_model_info_schema_mismatch:"
            f"{schema_version or '<empty>'}:{MODEL_INFO_SCHEMA_VERSION}"
        )
    model_fields = (
        "name",
        "root_path",
        "model_path",
        "model_url",
        "icon_url",
        "resource_scan",
        "parameter_scan",
        "expression_scan",
        "parameter_action_library",
        "constraints",
        "semantic_axis_profile",
        "voice_following_profile",
        "engine_hints",
    )
    models = model_info.get("models")
    if not isinstance(models, list):
        raise RuntimeError("live2d_model_info_models_invalid")
    projected_models: list[dict[str, Any]] = []
    for model in models:
        if not isinstance(model, dict):
            raise RuntimeError("live2d_model_info_model_invalid")
        missing = [field for field in model_fields if field not in model]
        if missing:
            raise RuntimeError(
                "live2d_frontend_model_projection_missing_fields:"
                + ",".join(missing)
            )
        projected_model = {field: deepcopy(model[field]) for field in model_fields}
        projected_model["constraints"] = _project_frontend_resource_constraints(
            model["constraints"]
        )
        projected_models.append(projected_model)
    return {
        **{field: deepcopy(model_info[field]) for field in root_fields},
        "models": projected_models,
    }


def _project_frontend_resource_constraints(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise RuntimeError("live2d_model_constraints_invalid")
    expressions = value.get("expressions")
    motions = value.get("motions")
    if not isinstance(expressions, list) or not isinstance(motions, list):
        raise RuntimeError("live2d_model_resource_constraints_invalid")
    if not all(isinstance(item, dict) for item in expressions):
        raise RuntimeError("live2d_expression_resource_constraint_invalid")
    if not all(isinstance(item, dict) for item in motions):
        raise RuntimeError("live2d_motion_resource_constraint_invalid")
    expression_fields = (
        "name",
        "file",
        "catalog_id",
        "catalog_expose_as_resource",
        "parameter_ids",
    )
    motion_fields = (
        "name",
        "file",
        "catalog_id",
        "catalog_expose_as_resource",
        "group",
        "group_index",
        "duration",
        "parameter_ids",
        "catalog_label",
        "catalog_intensity",
    )
    for resource_type, items, fields in (
        ("expression", expressions, expression_fields),
        ("motion", motions, motion_fields),
    ):
        for index, item in enumerate(items):
            missing = [field for field in fields if field not in item]
            if missing:
                raise RuntimeError(
                    f"live2d_{resource_type}_resource_projection_missing_fields:"
                    f"{index}:" + ",".join(missing)
                )
    return {
        "expressions": [
            {field: deepcopy(item[field]) for field in expression_fields}
            for item in expressions
        ],
        "motions": [
            {field: deepcopy(item[field]) for field in motion_fields}
            for item in motions
        ],
    }


def _plugin_config_get(config: Any, key: str, default: Any) -> Any:
    if config is None:
        return default
    if hasattr(config, "get"):
        value = config.get(key, default)
        return default if value is None else value
    return default
