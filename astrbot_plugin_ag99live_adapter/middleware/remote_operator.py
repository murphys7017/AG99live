from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
import threading
from typing import Any

from astrbot.core.prompt import PromptExtension


@dataclass(frozen=True, slots=True)
class RemoteOperatorConfig:
    default_computer: str
    computers: dict[str, str]


_registry_lock = threading.RLock()
_online_computer_keys: set[str] = set()


class AG99liveRemoteOperatorPromptContributor:
    plugin_id = "ag99live.remote_operator.prompt"
    priority = 35

    async def collect(self, event, plugin_context, view):
        del plugin_context, view

        if not _is_ag99live_event(event):
            return None

        config = resolve_remote_operator_config(_load_plugin_config())
        if config is None:
            return None

        online_config = filter_online_remote_operator_config(config)
        if online_config is None:
            return None

        return PromptExtension(
            plugin_id=self.plugin_id,
            mount="system",
            title="AG99live Remote Operator Routing",
            value_kind="text",
            value=build_remote_operator_prompt(online_config),
            order=35,
            meta={
                "scope": "dynamic",
                "node_type": "ag99live_remote_operator_routing",
            },
        )


def register_remote_operator_interaction_contributors(context: Any) -> None:
    register_prompt = getattr(context, "register_interaction_prompt_contributor", None)
    if callable(register_prompt):
        register_prompt(AG99liveRemoteOperatorPromptContributor())


def set_remote_operator_online_computers(computer_keys: Any) -> None:
    next_keys: set[str] = set()
    if isinstance(computer_keys, (list, tuple, set)):
        for item in computer_keys:
            key = _normalize_key(item)
            if key:
                next_keys.add(key)

    with _registry_lock:
        _online_computer_keys.clear()
        _online_computer_keys.update(next_keys)


def mark_remote_operator_computer_online(computer_key: Any) -> None:
    key = _normalize_key(computer_key)
    if not key:
        return
    with _registry_lock:
        _online_computer_keys.add(key)


def mark_remote_operator_computer_offline(computer_key: Any) -> None:
    key = _normalize_key(computer_key)
    if not key:
        return
    with _registry_lock:
        _online_computer_keys.discard(key)


def get_remote_operator_online_computers() -> set[str]:
    with _registry_lock:
        return set(_online_computer_keys)


def resolve_remote_operator_config(config: Any) -> RemoteOperatorConfig | None:
    if not isinstance(config, Mapping):
        return None

    computers = _normalize_computers(config.get("remote_operator_computers"))
    if not computers:
        return None

    default_computer = _normalize_key(config.get("remote_operator_default_computer"))
    if default_computer not in computers:
        default_computer = next(iter(computers))

    return RemoteOperatorConfig(
        default_computer=default_computer,
        computers=computers,
    )


def filter_online_remote_operator_config(
    config: RemoteOperatorConfig,
) -> RemoteOperatorConfig | None:
    online_keys = get_remote_operator_online_computers()
    if not online_keys:
        return None

    online_computers = {
        key: label
        for key, label in config.computers.items()
        if key in online_keys
    }
    if not online_computers:
        return None

    default_computer = config.default_computer
    if default_computer not in online_computers:
        default_computer = next(iter(online_computers))

    return RemoteOperatorConfig(
        default_computer=default_computer,
        computers=online_computers,
    )


def build_remote_operator_prompt(config: RemoteOperatorConfig) -> str:
    lines = [
        "当用户明确要求操作电脑、打开软件、使用浏览器、检查本机项目或让远程执行器完成任务时，生成远程执行器请求。",
        "远程执行器请求只能包含两个字段：",
        '{"computer":"<computer_key>","prompt":"<交给远程执行器的完整任务说明>"}',
        "不要输出底层点击、坐标、键盘、UIA selector 或 shell 步骤；这些由远程执行器自行决定。",
        f"如果用户没有指定电脑，computer 使用默认电脑 `{config.default_computer}`。",
        "可用电脑名称映射：",
    ]
    for key, label in config.computers.items():
        default_suffix = "（默认）" if key == config.default_computer else ""
        lines.append(f"- {label} -> {key}{default_suffix}")
    return "\n".join(lines)


def _normalize_computers(value: Any) -> dict[str, str]:
    if not isinstance(value, Mapping):
        return {}

    computers: dict[str, str] = {}
    for raw_key, raw_label in value.items():
        key = _normalize_key(raw_key)
        label = str(raw_label or "").strip()
        if not key or not label:
            continue
        if key in computers:
            continue
        computers[key] = label
    return computers


def _normalize_key(value: Any) -> str:
    return str(value or "").strip()


def _is_ag99live_event(event: Any) -> bool:
    platform_id = _call_event_method(event, "get_platform_id")
    platform_name = _call_event_method(event, "get_platform_name")
    return platform_id == "olv_pet_adapter" or platform_name == "olv_pet_adapter"


def _call_event_method(event: Any, name: str) -> Any:
    method = getattr(event, name, None)
    if not callable(method):
        return None
    try:
        return method()
    except Exception:
        return None


def _load_plugin_config() -> Any:
    from ..runtime.plugin_runtime import get_plugin_config

    return get_plugin_config()
