from __future__ import annotations

from copy import deepcopy
import json
import os
from pathlib import Path
import threading
from typing import Any

from astrbot.api import logger
from astrbot.core.utils.astrbot_path import get_astrbot_config_path

_state_lock = threading.RLock()
_plugin_context: Any = None
_plugin_config: Any = None
_plugin_config_path: str | None = None
_default_plugin_config_path = os.path.join(
    get_astrbot_config_path(),
    f"{Path(__file__).resolve().parents[1].name}_config.json",
)


def set_plugin_context(context: Any) -> None:
    global _plugin_context
    with _state_lock:
        _plugin_context = context


def get_plugin_context() -> Any:
    with _state_lock:
        return _plugin_context


def set_plugin_config(config: Any) -> None:
    global _plugin_config
    global _plugin_config_path
    with _state_lock:
        _plugin_config = deepcopy(config)
        config_path = getattr(config, "config_path", None)
        _plugin_config_path = config_path if isinstance(config_path, str) and config_path else None


def get_plugin_config() -> Any:
    with _state_lock:
        disk_config = _load_plugin_config_from_disk(
            _plugin_config_path,
            source_label="plugin config",
        )
        if disk_config is None:
            disk_config = _load_plugin_config_from_disk(
                _default_plugin_config_path,
                source_label="default plugin config",
            )
        if disk_config is not None:
            return disk_config
        return deepcopy(_plugin_config)


def _load_plugin_config_from_disk(
    config_path: str | None,
    *,
    source_label: str,
) -> dict[str, Any] | None:
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
    return deepcopy(data)
