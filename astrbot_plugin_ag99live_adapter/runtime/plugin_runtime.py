from __future__ import annotations

from collections.abc import Mapping
from copy import deepcopy
from dataclasses import dataclass
import json
import os
import threading
from typing import Any

from astrbot.api import logger
from astrbot.core.utils.astrbot_path import get_astrbot_config_path

_state_lock = threading.RLock()
_plugin_context: Any = None
_plugin_config: dict[str, Any] = {}
_plugin_config_path: str | None = None
_control_platforms: dict[str, Any] = {}
ADAPTER_PLATFORM_NAME = "olv_pet_adapter"
PLUGIN_CONFIG_BASENAME = "astrbot_plugin_ag99live_adapter_config.json"
_default_plugin_config_paths = tuple(
    os.path.join(get_astrbot_config_path(), filename)
    for filename in (PLUGIN_CONFIG_BASENAME,)
)


@dataclass(frozen=True)
class PluginConfigSnapshot:
    config: dict[str, Any]
    source: str
    path: str | None
    mtime_ns: int | None


def get_config_value(config: Mapping[str, Any] | None, key: str, default: Any) -> Any:
    if config is None:
        return default
    value = config.get(key, default)
    return default if value is None else value


def set_plugin_context(context: Any) -> None:
    global _plugin_context
    with _state_lock:
        _plugin_context = context


def get_plugin_context() -> Any:
    with _state_lock:
        return _plugin_context


def register_control_platform(platform_id: str, platform: Any) -> None:
    key = str(platform_id or "").strip()
    if not key:
        raise ValueError("control_platform_id_required")
    with _state_lock:
        _control_platforms[key] = platform


def unregister_control_platform(platform_id: str, platform: Any) -> None:
    key = str(platform_id or "").strip()
    with _state_lock:
        if _control_platforms.get(key) is platform:
            del _control_platforms[key]


def get_control_platform(platform_id: str) -> Any | None:
    key = str(platform_id or "").strip()
    with _state_lock:
        return _control_platforms.get(key)


def list_control_platforms() -> list[Any]:
    with _state_lock:
        return list(_control_platforms.values())


def reconcile_control_platforms(context: Any) -> list[Any]:
    """Re-bind the control registry to the platform instances AstrBot actually runs.

    A plugin reload drops every registration the plugin made, because the Star is
    rebuilt from scratch. Platform instances, however, belong to PlatformManager
    and survive a plugin reload: they keep their WebSocket and keep serving the
    desktop. That left the registry empty while a live adapter was still running,
    so the control page reported "no adapter instance" after every deploy.

    Rebinding from the manager makes the registry a cache of reality instead of a
    record of plugin lifetime. The stable platform metadata name identifies the
    surviving instance even when AstrBot retains an object from the previous
    plugin class after reload.
    """
    manager = getattr(context, "platform_manager", None)
    instances = getattr(manager, "platform_insts", None)
    if instances is None:
        # Nothing to verify against; leave the registry as it is.
        return list_control_platforms()

    live: dict[str, Any] = {}
    for platform in list(instances):
        metadata_method = getattr(platform, "meta", None)
        if not callable(metadata_method):
            continue
        try:
            metadata = metadata_method()
        except Exception as exc:
            logger.debug(
                "Skipping platform with unreadable metadata during AG99live "
                "control registry reconciliation (%s): %s",
                type(platform).__name__,
                exc,
            )
            continue
        if getattr(metadata, "name", None) != ADAPTER_PLATFORM_NAME:
            continue
        platform_id = str(getattr(platform, "platform_id", "") or "").strip()
        if platform_id:
            live[platform_id] = platform

    with _state_lock:
        for key, platform in live.items():
            _control_platforms[key] = platform
        for key in [known for known in _control_platforms if known not in live]:
            del _control_platforms[key]
        return list(_control_platforms.values())


def get_live_control_platform(context: Any, platform_id: str) -> Any | None:
    """Resolve a platform by id, refreshing the registry from the manager first."""
    reconcile_control_platforms(context)
    return get_control_platform(platform_id)


def set_plugin_config(config: Mapping[str, Any] | None) -> None:
    global _plugin_config
    global _plugin_config_path
    with _state_lock:
        # AstrBotConfig is a dict subclass with framework-owned state that is not deepcopy-safe.
        _plugin_config = dict(config or {})
        config_path = getattr(config, "config_path", None)
        _plugin_config_path = config_path if isinstance(config_path, str) and config_path else None


def get_plugin_config_snapshot() -> PluginConfigSnapshot:
    with _state_lock:
        disk_snapshot = _load_plugin_config_from_disk(
            _plugin_config_path,
            source_label="plugin config",
            source="plugin_config_file",
        )
        if disk_snapshot is None:
            for default_config_path in _default_plugin_config_paths:
                disk_snapshot = _load_plugin_config_from_disk(
                    default_config_path,
                    source_label="default plugin config",
                    source="default_plugin_config_file",
                )
                if disk_snapshot is not None:
                    break
        if disk_snapshot is not None:
            return disk_snapshot
        return PluginConfigSnapshot(
            config=deepcopy(_plugin_config),
            source="injected_snapshot",
            path=None,
            mtime_ns=None,
        )


def _load_plugin_config_from_disk(
    config_path: str | None,
    *,
    source_label: str,
    source: str,
) -> PluginConfigSnapshot | None:
    if not config_path or not os.path.exists(config_path):
        return None

    try:
        with open(config_path, encoding="utf-8-sig") as f:
            data = json.load(f)
    except Exception as exc:
        logger.error("Failed to load %s from `%s`: %s", source_label, config_path, exc)
        raise RuntimeError(
            f"Failed to load {source_label} from `{config_path}`: {exc}"
        ) from exc

    if not isinstance(data, dict):
        logger.error(
            "Invalid %s in `%s`: expected a JSON object, got `%s`.",
            source_label,
            config_path,
            type(data).__name__,
        )
        raise RuntimeError(
            f"Invalid {source_label} in `{config_path}`: expected a JSON object."
        )
    try:
        mtime_ns = os.stat(config_path).st_mtime_ns
    except OSError:
        mtime_ns = None

    return PluginConfigSnapshot(
        config=deepcopy(data),
        source=source,
        path=config_path,
        mtime_ns=mtime_ns,
    )
