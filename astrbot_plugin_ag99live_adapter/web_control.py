from __future__ import annotations

import asyncio
from copy import deepcopy
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
from .runtime.plugin_runtime import (
    get_control_platform,
    list_control_platforms,
    set_plugin_config,
)

_PLUGIN_NAME = "astrbot_plugin_ag99live_adapter"
_PAGE_API_PREFIX = "/control"
_SETTINGS_SECTIONS = {
    "general": {"client_uid", "client_nickname", "chat_buffer_size"},
    "live2d_input": {"model_name", "image_cooldown_seconds"},
    "performance_curve": {"enabled", "provider_id"},
    "vad": {"prob_threshold", "required_hits", "required_misses"},
}


def normalize_settings_patch(value: Any) -> dict[str, dict[str, Any]]:
    if not isinstance(value, dict) or not value:
        raise ValueError("settings_patch_must_be_non_empty_object")

    normalized: dict[str, dict[str, Any]] = {}
    for section, fields in value.items():
        if section not in _SETTINGS_SECTIONS or not isinstance(fields, dict):
            raise ValueError(f"settings_section_invalid:{section}")
        allowed_fields = _SETTINGS_SECTIONS[section]
        if not fields or set(fields) - allowed_fields:
            raise ValueError(f"settings_fields_invalid:{section}")
        normalized[section] = {
            key: _normalize_setting_value(section, key, field_value)
            for key, field_value in fields.items()
        }

    if normalized.get("performance_curve", {}).get("enabled"):
        provider_id = normalized.get("performance_curve", {}).get("provider_id")
        if provider_id is None:
            provider_id = ""
        if not provider_id.strip():
            raise ValueError("performance_curve_provider_required")
    return normalized


def _normalize_setting_value(section: str, key: str, value: Any) -> Any:
    if section == "general" and key in {"client_uid", "client_nickname"}:
        if not isinstance(value, str) or not value.strip() or len(value.strip()) > 128:
            raise ValueError(f"settings_value_invalid:{section}.{key}")
        return value.strip()
    if section == "general" and key == "chat_buffer_size":
        return _bounded_integer(section, key, value, minimum=1, maximum=100)
    if section == "live2d_input" and key == "model_name":
        if not isinstance(value, str) or len(value.strip()) > 255:
            raise ValueError(f"settings_value_invalid:{section}.{key}")
        return value.strip()
    if section == "live2d_input" and key == "image_cooldown_seconds":
        return _bounded_integer(section, key, value, minimum=0, maximum=86400)
    if section == "performance_curve" and key == "enabled":
        if not isinstance(value, bool):
            raise ValueError(f"settings_value_invalid:{section}.{key}")
        return value
    if section == "performance_curve" and key == "provider_id":
        if not isinstance(value, str) or len(value.strip()) > 255:
            raise ValueError(f"settings_value_invalid:{section}.{key}")
        return value.strip()
    if section == "vad" and key == "prob_threshold":
        if isinstance(value, bool) or not isinstance(value, (float, int)):
            raise ValueError(f"settings_value_invalid:{section}.{key}")
        numeric = float(value)
        if not isfinite(numeric) or not 0 < numeric <= 1:
            raise ValueError(f"settings_value_out_of_range:{section}.{key}")
        return numeric
    if section == "vad" and key == "required_hits":
        return _bounded_integer(section, key, value, minimum=1, maximum=120)
    if section == "vad" and key == "required_misses":
        return _bounded_integer(section, key, value, minimum=1, maximum=1000)
    raise ValueError(f"settings_field_unsupported:{section}.{key}")


def _bounded_integer(
    section: str,
    key: str,
    value: Any,
    *,
    minimum: int,
    maximum: int,
) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"settings_value_invalid:{section}.{key}")
    if not minimum <= value <= maximum:
        raise ValueError(f"settings_value_out_of_range:{section}.{key}")
    return value


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


class WebControlPageApi:
    def __init__(self, plugin: Any) -> None:
        self._plugin = plugin
        self._settings_lock = asyncio.Lock()

    async def get_overview(self):
        if response := _require_dashboard_user():
            return response
        platforms = []
        for platform in list_control_platforms():
            model_info = platform.runtime_state.model_info
            platforms.append({
                "platform_id": platform.platform_id,
                "host": platform.host,
                "websocket_port": platform.port,
                "http_port": platform.http_port,
                "connected": platform.transport._ws_client is not None,
                "selected_model": str(model_info.get("selected_model") or ""),
                "available_models": list(model_info.get("available_models") or []),
            })
        return jsonify({"platforms": platforms})

    async def get_settings(self):
        if response := _require_dashboard_user():
            return response
        return jsonify({"settings": _project_settings(self._plugin.config)})

    async def save_settings(self):
        if response := _require_dashboard_user():
            return response
        body = await _read_json_body()
        if isinstance(body, tuple):
            return body[1]
        try:
            patch = normalize_settings_patch(body.get("settings"))
        except ValueError as exc:
            return _error(str(exc), 400)

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
                for platform in list_control_platforms():
                    await platform._refresh_runtime_settings_async(reload_providers=True)
                    await platform._send_current_model_and_conf(force=True)
            except Exception as exc:
                logger.exception("AG99live web settings update failed")
                try:
                    self._replace_plugin_config(previous)
                    save_config()
                    set_plugin_config(self._plugin.config)
                    for platform in list_control_platforms():
                        await platform._refresh_runtime_settings_async(reload_providers=True)
                except Exception:
                    logger.exception("AG99live web settings rollback failed")
                return _error("settings_save_failed", 500, detail=str(exc))
        return jsonify({"settings": _project_settings(self._plugin.config)})

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
        platform = get_control_platform(platform_id)
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
        platform = get_control_platform(str(body.get("platform_id") or "").strip())
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
        platform = get_control_platform(str(body.get("platform_id") or "").strip())
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
    platform = get_control_platform(platform_id)
    if not platform:
        return None, _error("platform_not_found", 404)
    return platform, None


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
    source = config if isinstance(config, dict) else {}
    return {
        section: deepcopy(source.get(section) or {})
        for section in _SETTINGS_SECTIONS
    }


def _error(code: str, status: int, *, detail: str = ""):
    payload = {"status": "error", "message": code, "data": None}
    if detail:
        logger.debug("AG99live web control rejected request code=%s detail=%s", code, detail)
    return jsonify(payload), status
