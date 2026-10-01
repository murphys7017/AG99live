from __future__ import annotations

import asyncio
from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime, timezone
from math import isfinite
from typing import Any
from uuid import uuid4

from astrbot.api import logger
from quart import g, jsonify, request

from .live2d.semantic_axis_profile import (
    SemanticAxisProfileError,
    SemanticAxisProfileRevisionError,
)
from .protocol.constants import (
    DESKTOP_SETTINGS_ACTION_LIST,
    DESKTOP_SETTINGS_ACTION_SET,
    DESKTOP_SETTINGS_ACTIONS,
)
from .runtime.desktop_settings_broker import DesktopSettingsError
from .runtime.plugin_runtime import (
    get_live_control_platform,
    get_plugin_context,
    reconcile_control_platforms,
    set_plugin_config,
)

_PLUGIN_NAME = "astrbot_plugin_ag99live_adapter"
_PAGE_API_PREFIX = "/control"


@dataclass(frozen=True)
class ConfigField:
    """One editable plugin setting.

    The control page renders its settings form from this spec, so a field is
    declared exactly once and validation, defaults and UI metadata cannot drift.
    """

    key: str
    kind: str
    label: str
    description: str
    default: Any
    minimum: float | None = None
    maximum: float | None = None
    step: float | None = None
    max_length: int | None = None
    required: bool = True
    options_from: str | None = None

    def to_json(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "key": self.key,
            "kind": self.kind,
            "label": self.label,
            "description": self.description,
            "default": self.default,
            "required": self.required,
        }
        optional = {
            "minimum": self.minimum,
            "maximum": self.maximum,
            "step": self.step,
            "maxLength": self.max_length,
            "optionsFrom": self.options_from,
        }
        for name, value in optional.items():
            if value is not None:
                payload[name] = value
        return payload


@dataclass(frozen=True)
class ConfigSection:
    key: str
    label: str
    description: str
    fields: tuple[ConfigField, ...]

    def to_json(self) -> dict[str, Any]:
        return {
            "key": self.key,
            "label": self.label,
            "description": self.description,
            "fields": [field.to_json() for field in self.fields],
        }


CONFIG_SCHEMA: tuple[ConfigSection, ...] = (
    ConfigSection(
        key="general",
        label="基础身份与会话",
        description="桌面端在 AstrBot 中使用的身份标识，以及它维护的对话上下文长度。",
        fields=(
            ConfigField(
                key="client_uid",
                kind="text",
                label="Client UID",
                description="桌面端前端在 AstrBot 中使用的用户 ID。",
                default="desktop-client",
                max_length=128,
            ),
            ConfigField(
                key="client_nickname",
                kind="text",
                label="显示名称",
                description="桌面端前端在 AstrBot 中显示的用户昵称。",
                default="DesktopUser",
                max_length=128,
            ),
            ConfigField(
                key="chat_buffer_size",
                kind="int",
                label="对话缓冲条数",
                description="桌面端维护的最近用户/助手文本条数。",
                default=10,
                minimum=1,
                maximum=100,
                step=1,
            ),
        ),
    ),
    ConfigSection(
        key="live2d_input",
        label="Live2D 与图片输入",
        description="控制桌面端优先加载的 Live2D 模型，以及图片输入的节流策略。",
        fields=(
            ConfigField(
                key="model_name",
                kind="model",
                label="优先模型",
                description="优先加载的 Live2D 模型目录名。留空时使用扫描到的第一个模型。",
                default="",
                max_length=255,
                required=False,
                options_from="models",
            ),
            ConfigField(
                key="image_cooldown_seconds",
                kind="int",
                label="图片输入冷却（秒）",
                description=(
                    "冷却期内的新图片会被丢弃，但文本仍正常提交；0 表示不限制。"
                ),
                default=0,
                minimum=0,
                maximum=86400,
                step=1,
            ),
        ),
    ),
    ConfigSection(
        key="performance_curve",
        label="可选表演曲线",
        description="为动作生成进入、保持和退出节奏提示；失败或超时不影响原动作播放。",
        fields=(
            ConfigField(
                key="enabled",
                kind="bool",
                label="启用独立表演曲线 Provider",
                description="调用独立 Provider 为动作生成进入、保持和退出节奏提示。",
                default=False,
            ),
            ConfigField(
                key="provider_id",
                kind="provider",
                label="表演曲线 Provider",
                description="启用后必须选择一个聊天 Provider，不复用当前会话聊天模型。",
                default="",
                max_length=255,
                required=False,
                options_from="providers",
            ),
        ),
    ),
    ConfigSection(
        key="vad",
        label="语音断句",
        description="Silero VAD 判定当前音频帧为语音的阈值，以及开始/结束所需的连续帧数。",
        fields=(
            ConfigField(
                key="prob_threshold",
                kind="float",
                label="语音概率阈值",
                description="Silero VAD 判定当前音频帧为语音的概率阈值。",
                default=0.4,
                minimum=0.01,
                maximum=1.0,
                step=0.01,
            ),
            ConfigField(
                key="required_hits",
                kind="int",
                label="开始命中帧数",
                description="开始一次语音输入前要求连续命中的帧数。",
                default=3,
                minimum=1,
                maximum=120,
                step=1,
            ),
            ConfigField(
                key="required_misses",
                kind="int",
                label="结束静音帧数",
                description="结束一次语音输入前要求连续静音的帧数。",
                default=24,
                minimum=1,
                maximum=1000,
                step=1,
            ),
        ),
    ),
)

_SECTIONS_BY_KEY = {section.key: section for section in CONFIG_SCHEMA}
_FIELDS_BY_PATH = {
    f"{section.key}.{field.key}": field
    for section in CONFIG_SCHEMA
    for field in section.fields
}


@dataclass(frozen=True)
class DesktopSetting:
    """A setting the desktop owns but the control page can still drive.

    The value physically belongs to the machine running the desktop; the page
    reaches it through the adapter's broker, so the adapter never stores it as
    authoritative. This spec exists only so the page can label the control.
    """

    key: str
    label: str
    description: str

    def to_json(self) -> dict[str, Any]:
        return {
            "key": self.key,
            "label": self.label,
            "description": self.description,
        }


DESKTOP_SETTINGS_SPEC: tuple[DesktopSetting, ...] = (
    DesktopSetting(
        key="microphone_device",
        label="麦克风设备",
        description="桌宠从这台电脑上的哪个麦克风收音。设备由桌面端枚举，选项以桌面端实际可用为准。",
    ),
)

_DESKTOP_SETTINGS_BY_KEY = {setting.key: setting for setting in DESKTOP_SETTINGS_SPEC}


class ConfigValidationError(ValueError):
    """A rejected settings patch, anchored to the offending field when known."""

    def __init__(self, code: str, field: str = "", detail: str = "") -> None:
        super().__init__(code)
        self.code = code
        self.field = field
        self.detail = detail

    def to_json(self) -> dict[str, Any]:
        payload: dict[str, Any] = {"code": self.code}
        if self.field:
            payload["field"] = self.field
        if self.detail:
            payload["detail"] = self.detail
        return payload


def default_settings() -> dict[str, dict[str, Any]]:
    return {
        section.key: {field.key: field.default for field in section.fields}
        for section in CONFIG_SCHEMA
    }


def normalize_settings_patch(value: Any) -> dict[str, dict[str, Any]]:
    if not isinstance(value, dict) or not value:
        raise ConfigValidationError("settings_patch_must_be_non_empty_object")

    normalized: dict[str, dict[str, Any]] = {}
    for section_key, fields in value.items():
        section = _SECTIONS_BY_KEY.get(section_key)
        if section is None or not isinstance(fields, dict) or not fields:
            raise ConfigValidationError("settings_fields_invalid", str(section_key))
        normalized[section_key] = {
            field_key: _normalize_setting_value(
                f"{section_key}.{field_key}",
                _field(section_key, field_key),
                fields[field_key],
            )
            for field_key in fields
        }

    _normalize_cross_field(normalized)
    _verify_providers(normalized)
    return normalized


def _field(section_key: str, field_key: str) -> ConfigField:
    field = _FIELDS_BY_PATH.get(f"{section_key}.{field_key}")
    if field is None:
        raise ConfigValidationError(
            "settings_field_unsupported", f"{section_key}.{field_key}"
        )
    return field


def _normalize_setting_value(path: str, field: ConfigField, value: Any) -> Any:
    if field.kind in {"text", "model", "provider"}:
        if not isinstance(value, str):
            raise ConfigValidationError("settings_value_invalid", path)
        normalized = value.strip()
        if field.max_length is not None and len(normalized) > field.max_length:
            raise ConfigValidationError("settings_value_too_long", path)
        if field.required and not normalized:
            raise ConfigValidationError("settings_value_required", path)
        return normalized
    if field.kind == "int":
        if isinstance(value, bool) or not isinstance(value, int):
            raise ConfigValidationError("settings_value_invalid", path)
        return _bounded_value(field, value, path)
    if field.kind == "float":
        if isinstance(value, bool) or not isinstance(value, (float, int)):
            raise ConfigValidationError("settings_value_invalid", path)
        numeric = float(value)
        if not isfinite(numeric):
            raise ConfigValidationError("settings_value_invalid", path)
        return _bounded_value(field, numeric, path)
    if field.kind == "bool":
        if not isinstance(value, bool):
            raise ConfigValidationError("settings_value_invalid", path)
        return value
    raise ConfigValidationError("settings_field_unsupported", path)


def _bounded_value(field: ConfigField, value: Any, path: str) -> Any:
    if field.minimum is not None and value < field.minimum:
        raise ConfigValidationError("settings_value_out_of_range", path)
    if field.maximum is not None and value > field.maximum:
        raise ConfigValidationError("settings_value_out_of_range", path)
    return value


def _normalize_cross_field(normalized: dict[str, dict[str, Any]]) -> None:
    curve = normalized.get("performance_curve")
    if curve and curve.get("enabled") and not str(curve.get("provider_id") or "").strip():
        raise ConfigValidationError(
            "performance_curve_provider_required", "performance_curve.provider_id"
        )


def _verify_providers(normalized: dict[str, dict[str, Any]]) -> None:
    """Reject a saved provider id that no longer exists in AstrBot.

    Only an explicit save is rejected: reading settings must still work when a
    configured provider has been removed, so the page can show and fix it.
    """
    known: list[str] | None = None
    for section in CONFIG_SCHEMA:
        values = normalized.get(section.key)
        if not isinstance(values, dict):
            continue
        for field in section.fields:
            if field.kind != "provider":
                continue
            provider_id = str(values.get(field.key) or "").strip()
            if not provider_id:
                continue
            if known is None:
                known = [option["id"] for option in _list_chat_providers()]
            if known and provider_id not in known:
                raise ConfigValidationError(
                    "settings_provider_unknown",
                    f"{section.key}.{field.key}",
                    provider_id,
                )


def _list_chat_providers() -> list[dict[str, str]]:
    context = get_plugin_context()
    if context is None:
        return []
    try:
        providers = context.get_all_providers()
    except Exception:  # pragma: no cover - provider manager is optional at runtime
        logger.debug("AG99live web control could not list chat providers")
        return []
    options: list[dict[str, str]] = []
    for provider in providers:
        try:
            meta = provider.meta()
        except Exception:
            continue
        provider_id = str(getattr(meta, "id", "") or "").strip()
        if not provider_id:
            continue
        options.append(
            {
                "id": provider_id,
                "model": str(getattr(meta, "model", "") or ""),
                "type": str(getattr(meta, "type", "") or ""),
            }
        )
    return sorted(options, key=lambda option: option["id"])


def register_web_control_page(context: Any, plugin: Any) -> bool:
    register = getattr(context, "register_web_api", None)
    if not callable(register):
        logger.warning(
            "AG99live Control Page requires AstrBot Plugin Pages Web API support."
        )
        return False

    api = WebControlPageApi(plugin)
    routes = (
        ("/overview", api.get_overview, ["GET"], "AG99live control page overview"),
        ("/config/schema", api.get_config_schema, ["GET"], "Read AG99live config form schema"),
        ("/desktop/settings", api.get_desktop_settings, ["GET"], "Read desktop-owned settings"),
        ("/desktop/settings", api.apply_desktop_setting, ["POST"], "Query or apply a desktop-owned setting"),
        ("/settings", api.get_settings, ["GET"], "Read AG99live adapter settings"),
        ("/settings", api.save_settings, ["POST"], "Save AG99live adapter settings"),
        ("/profile", api.get_profile, ["GET"], "Read a Live2D semantic profile"),
        ("/profile", api.save_profile, ["POST"], "Save a Live2D semantic profile"),
        ("/samples", api.get_samples, ["GET"], "Read motion tuning samples"),
        ("/samples", api.save_sample, ["POST"], "Save a motion tuning sample"),
        ("/samples/delete", api.delete_sample, ["POST"], "Delete a motion tuning sample"),
    )
    for path, handler, methods, description in routes:
        register(
            route=f"/{_PLUGIN_NAME}{_PAGE_API_PREFIX}{path}",
            view_handler=handler,
            methods=methods,
            desc=description,
        )
    return True


def _live_control_platforms() -> list[Any]:
    """Registered platforms, rebound to the ones AstrBot actually runs."""
    return reconcile_control_platforms(get_plugin_context())


def _live_control_platform(platform_id: str) -> Any | None:
    return get_live_control_platform(get_plugin_context(), platform_id)


class WebControlPageApi:
    def __init__(self, plugin: Any) -> None:
        self._plugin = plugin
        self._settings_lock = asyncio.Lock()

    async def get_overview(self):
        if response := _require_dashboard_user():
            return response
        platforms = []
        for platform in _live_control_platforms():
            model_info = platform.runtime_state.model_info
            platforms.append({
                "platform_id": platform.platform_id,
                "host": platform.host,
                "websocket_port": platform.port,
                "http_port": platform.http_port,
                "speaker_name": platform.speaker_name,
                "auto_start_mic": platform.auto_start_mic,
                "connected": platform.transport._ws_client is not None,
                "selected_model": str(model_info.get("selected_model") or ""),
                "available_models": list(model_info.get("available_models") or []),
            })
        return jsonify({"platforms": platforms})

    async def get_config_schema(self):
        """Serve the form spec the control page renders the settings form from.

        The page must not carry its own copy of the config shape: validation,
        defaults and the rendered form all read this single spec.
        """
        if response := _require_dashboard_user():
            return response
        return jsonify({
            "sections": [section.to_json() for section in CONFIG_SCHEMA],
            "defaults": default_settings(),
            "providers": _list_chat_providers(),
        })

    async def get_settings(self):
        if response := _require_dashboard_user():
            return response
        return jsonify({"settings": _project_settings(self._plugin.config)})

    async def get_desktop_settings(self):
        """Report what the desktop last said, which stays valid while it is offline."""
        if response := _require_dashboard_user():
            return response
        platform_id = str(request.args.get("platform_id") or "").strip()
        return jsonify(_desktop_settings_payload(_live_control_platform(platform_id)))

    async def apply_desktop_setting(self):
        """Broker one list/set exchange between this page and the connected desktop."""
        if response := _require_dashboard_user():
            return response
        body = await _read_json_body()
        if isinstance(body, tuple):
            return body[1]
        platform, error = _resolve_platform_from_body(body)
        if error:
            return error

        key = str(body.get("key") or "").strip()
        action = str(body.get("action") or DESKTOP_SETTINGS_ACTION_LIST).strip()
        if key not in _DESKTOP_SETTINGS_BY_KEY:
            return _error("desktop_setting_unsupported", 400)
        if action not in DESKTOP_SETTINGS_ACTIONS:
            return _error("desktop_setting_action_invalid", 400)

        value: str | None = None
        if action == DESKTOP_SETTINGS_ACTION_SET:
            raw = body.get("value")
            if not isinstance(raw, str) or not raw.strip():
                return _error("desktop_setting_value_required", 400)
            value = raw.strip()

        try:
            entry = await platform.desktop_settings_broker.query(
                key=key,
                action=action,
                value=value,
            )
        except DesktopSettingsError as exc:
            # Reuse the same builder the read path uses: a raw broker snapshot
            # has no labels, and the page renders from these entries directly.
            return jsonify({
                "ok": False,
                "error": {"code": str(exc), "key": key},
                **_desktop_settings_payload(platform),
            })
        return jsonify({
            "ok": True,
            "key": key,
            "entry": entry,
            **_desktop_settings_payload(platform),
        })

    async def save_settings(self):
        if response := _require_dashboard_user():
            return response
        body = await _read_json_body()
        if isinstance(body, tuple):
            return body[1]
        try:
            patch = normalize_settings_patch(body.get("settings"))
        except ConfigValidationError as exc:
            # The bridge collapses an error response to a bare message string and
            # drops the field pointer, so a rejected patch is reported as a normal
            # result the page can anchor to the offending control and localize.
            return jsonify({"ok": False, "error": exc.to_json()})
        except ValueError as exc:
            return _error("settings_patch_invalid", 400, detail=str(exc))

        save_config = getattr(self._plugin.config, "save_config", None)
        if not callable(save_config):
            return _error("plugin_config_persistence_unavailable", 503)

        async with self._settings_lock:
            previous = deepcopy(dict(self._plugin.config))
            merged = deepcopy(previous)
            for section, fields in patch.items():
                current = merged.get(section)
                if not isinstance(current, dict):
                    current = {}
                merged[section] = {**current, **fields}
            try:
                self._replace_plugin_config(merged)
                save_config()
                set_plugin_config(self._plugin.config)
                for platform in _live_control_platforms():
                    await platform._refresh_runtime_settings_async(reload_providers=True)
                    await platform._send_current_model_and_conf(force=True)
            except Exception as exc:
                logger.exception("AG99live web settings update failed")
                try:
                    self._replace_plugin_config(previous)
                    save_config()
                    set_plugin_config(self._plugin.config)
                    for platform in _live_control_platforms():
                        await platform._refresh_runtime_settings_async(reload_providers=True)
                except Exception:
                    logger.exception("AG99live web settings rollback failed")
                return _error("settings_save_failed", 500, detail=str(exc))
        return jsonify({"ok": True, "settings": _project_settings(self._plugin.config)})

    async def get_profile(self):
        if response := _require_dashboard_user():
            return response
        platform, error = _resolve_platform_from_query()
        if error:
            return error
        model_name = str(request.args.get("model_name") or "").strip()
        model = _resolve_model(platform.runtime_state.model_info, model_name)
        if model is None:
            return _error("model_not_found", 404)
        profile = model.get("semantic_axis_profile")
        if not isinstance(profile, dict):
            return _error("semantic_axis_profile_not_found", 404)
        return jsonify({
            "model_name": model.get("name", ""),
            "profile": deepcopy(profile),
            "models": _model_choices(platform.runtime_state.model_info),
        })

    async def save_profile(self):
        if response := _require_dashboard_user():
            return response
        body = await _read_json_body()
        if isinstance(body, tuple):
            return body[1]
        platform_id = str(body.get("platform_id") or "").strip()
        platform = _live_control_platform(platform_id)
        if platform is None:
            return _error("platform_not_found", 404)
        model_name = str(body.get("model_name") or "").strip()
        profile_id = str(body.get("profile_id") or "").strip()
        expected_revision = body.get("expected_revision")
        request_id = str(body.get("request_id") or uuid4().hex).strip()
        if (
            not model_name
            or not profile_id
            or not isinstance(expected_revision, int)
            or isinstance(expected_revision, bool)
            or expected_revision < 1
            or not isinstance(body.get("profile"), dict)
        ):
            return _error("profile_save_payload_invalid", 400)
        try:
            saved = platform.runtime_state.save_semantic_axis_profile_update(
                model_name=model_name,
                profile_payload=body["profile"],
                expected_revision=expected_revision,
            )
        except SemanticAxisProfileRevisionError as exc:
            return _error("profile_revision_conflict", 409, detail=str(exc))
        except (FileNotFoundError, SemanticAxisProfileError) as exc:
            return _error("profile_validation_failed", 400, detail=str(exc))

        await platform._send_current_model_and_conf(force=True)
        return jsonify({
            "requestId": request_id,
            "ok": True,
            "modelName": model_name,
            "profileId": str(saved.get("profile_id") or profile_id),
            "expectedRevision": expected_revision,
            "revision": int(saved.get("revision") or 0),
            "sourceHash": str(saved.get("source_hash") or ""),
            "savedAt": str(saved.get("updated_at") or ""),
            "receivedAt": datetime.now(timezone.utc).isoformat(),
        })

    async def get_samples(self):
        if response := _require_dashboard_user():
            return response
        platform, error = _resolve_platform_from_query()
        if error:
            return error
        return _samples_response(platform)

    async def save_sample(self):
        if response := _require_dashboard_user():
            return response
        body = await _read_json_body()
        if isinstance(body, tuple):
            return body[1]
        platform = _live_control_platform(str(body.get("platform_id") or "").strip())
        if platform is None:
            return _error("platform_not_found", 404)
        try:
            platform.runtime_state.save_motion_tuning_sample(body.get("sample"))
        except ValueError as exc:
            return _error("motion_tuning_sample_invalid", 400, detail=str(exc))
        await platform._send_motion_tuning_samples_state()
        return _samples_response(platform)

    async def delete_sample(self):
        if response := _require_dashboard_user():
            return response
        body = await _read_json_body()
        if isinstance(body, tuple):
            return body[1]
        platform = _live_control_platform(str(body.get("platform_id") or "").strip())
        if platform is None:
            return _error("platform_not_found", 404)
        sample_id = body.get("sample_id")
        if not isinstance(sample_id, str) or not sample_id.strip():
            return _error("sample_id_required", 400)
        try:
            platform.runtime_state.delete_motion_tuning_sample(sample_id)
        except ValueError as exc:
            return _error("motion_tuning_sample_delete_failed", 400, detail=str(exc))
        await platform._send_motion_tuning_samples_state()
        return _samples_response(platform)

    def _replace_plugin_config(self, value: dict[str, Any]) -> None:
        self._plugin.config.clear()
        self._plugin.config.update(value)


def _require_dashboard_user():
    if not str(getattr(g, "username", "") or "").strip():
        return _error("astrbot_dashboard_login_required", 401)
    return None


async def _read_json_body():
    try:
        value = await request.get_json()
    except Exception:
        return None, _error("json_body_invalid", 400)
    if not isinstance(value, dict):
        return None, _error("json_body_must_be_object", 400)
    return value


def _resolve_platform_from_query():
    platform_id = str(request.args.get("platform_id") or "").strip()
    platform = _live_control_platform(platform_id)
    if not platform:
        return None, _error("platform_not_found", 404)
    return platform, None


def _resolve_platform_from_body(body: dict[str, Any]):
    platform = _live_control_platform(str(body.get("platform_id") or "").strip())
    if not platform:
        return None, _error("platform_not_found", 404)
    return platform, None


def _desktop_settings_payload(platform: Any) -> dict[str, Any]:
    """Assemble the offline-safe view of every declared desktop setting.

    A setting the desktop has never reported is present with an empty value
    rather than missing, so the page renders a stable list and can say
    "not reported yet" instead of silently dropping the control.
    """
    connected = bool(platform and platform.desktop_settings_broker.connected)
    snapshot = platform.desktop_settings_broker.snapshot() if platform else {}
    return {
        "connected": connected,
        "platformId": str(getattr(platform, "platform_id", "") or ""),
        "settings": {
            setting.key: {
                **setting.to_json(),
                **(
                    snapshot.get(setting.key)
                    or {"value": "", "options": [], "reportedAt": ""}
                ),
            }
            for setting in DESKTOP_SETTINGS_SPEC
        },
    }


def _resolve_model(model_info: dict[str, Any], model_name: str) -> dict[str, Any] | None:
    models = model_info.get("models")
    if not isinstance(models, list):
        return None
    if not model_name:
        model_name = str(model_info.get("selected_model") or "").strip()
    return next(
        (
            item for item in models
            if isinstance(item, dict) and item.get("name") == model_name
        ),
        None,
    )


def _model_choices(model_info: dict[str, Any]) -> list[dict[str, str]]:
    models = model_info.get("models")
    if not isinstance(models, list):
        return []
    return [
        {
            "name": str(model.get("name") or ""),
            "icon_url": str(model.get("icon_url") or ""),
        }
        for model in models
        if isinstance(model, dict) and str(model.get("name") or "").strip()
    ]


def _samples_response(platform: Any):
    state = platform.runtime_state
    return jsonify({
        "samples": state.list_motion_tuning_samples(),
        "status": {
            "root_error": state.get_motion_tuning_store_root_error(),
            "load_error": state.get_motion_tuning_samples_load_error(),
            "diagnostics": state.list_motion_tuning_fewshot_diagnostics(),
            "effective_examples": state.list_effective_motion_tuning_examples(),
        },
    })


def _project_settings(config: Any) -> dict[str, dict[str, Any]]:
    """Return a complete, valid settings shape for the page.

    Stored config is editable outside this plugin (AstrBot's own config UI and
    hand edits), so a value that no longer satisfies the spec degrades to the
    declared default instead of failing the whole page load. The page can then
    show the offending field and let the user correct it.
    """
    source = config if isinstance(config, dict) else {}
    projected: dict[str, dict[str, Any]] = {}
    for section in CONFIG_SCHEMA:
        stored = source.get(section.key)
        stored = stored if isinstance(stored, dict) else {}
        values: dict[str, Any] = {}
        for field in section.fields:
            raw = stored.get(field.key, field.default)
            try:
                values[field.key] = _normalize_setting_value(
                    f"{section.key}.{field.key}", field, raw
                )
            except ConfigValidationError:
                values[field.key] = field.default
        projected[section.key] = values
    return projected


def _error(code: str, status: int, *, detail: str = ""):
    payload = {"status": "error", "message": code, "data": None}
    if detail:
        logger.debug("AG99live web control rejected request code=%s detail=%s", code, detail)
    return jsonify(payload), status
