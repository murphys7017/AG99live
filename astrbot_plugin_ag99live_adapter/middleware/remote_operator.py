from __future__ import annotations

import asyncio
from collections.abc import Mapping
from dataclasses import dataclass
import json
import threading
from typing import Any

from astrbot.api import logger
from astrbot.core.interaction import InteractionResultContribution
from astrbot.core.prompt import PromptExtension


@dataclass(frozen=True, slots=True)
class RemoteOperatorConfig:
    default_computer: str
    computers: dict[str, str]
    default_profile: str
    profiles: dict[str, str]


_registry_lock = threading.RLock()
_online_computer_keys: set[str] = set()


class AG99liveRemoteOperatorPromptContributor:
    plugin_id = "ag99live.remote_operator.prompt"
    priority = 35

    async def collect(self, event, plugin_context, view):
        del plugin_context, view

        if not _is_ag99live_event(event):
            return None
        if _is_remote_operator_result_event(event):
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


class AG99liveRemoteOperatorResultContributor:
    plugin_id = "ag99live.remote_operator.result"
    priority = 35

    async def collect(self, event, plugin_context, view):
        del plugin_context

        if _get_event_extra(event, "ag99live_remote_operator_scheduled"):
            return None

        request, reason = parse_remote_operator_request_from_view(event, view)
        if request is None:
            if reason not in {"assistant_text_empty", "assistant_text_not_json"}:
                logger.info(
                    "Remote operator request ignored: reason=%s",
                    reason,
                )
            return None

        adapter = getattr(event, "adapter", None)
        runtime = getattr(adapter, "remote_operator_runtime", None)
        if runtime is None:
            return InteractionResultContribution(
                plugin_id=self.plugin_id,
                metadata={
                    "ag99live_remote_operator": {
                        "scheduled": False,
                        "reason": "runtime_unavailable",
                    }
                },
                priority=self.priority,
            )

        task = runtime.execute_and_submit(request)
        spawn = getattr(adapter, "spawn_background_task", None)
        if callable(spawn):
            spawn(task)
        else:
            asyncio.create_task(task)
        set_extra = getattr(event, "set_extra", None)
        if callable(set_extra):
            set_extra("ag99live_remote_operator_scheduled", True)

        return InteractionResultContribution(
            plugin_id=self.plugin_id,
            metadata={
                "ag99live_remote_operator": {
                    "scheduled": True,
                    "computer": request.computer,
                    "profile": request.profile,
                    "prompt": request.prompt,
                }
            },
            final_text_override="已收到远程执行请求，我会把执行结果作为系统消息继续处理。",
            priority=self.priority,
        )


def register_remote_operator_interaction_contributors(context: Any) -> None:
    register_prompt = getattr(context, "register_interaction_prompt_contributor", None)
    if callable(register_prompt):
        register_prompt(AG99liveRemoteOperatorPromptContributor())
    register_result = getattr(context, "register_interaction_result_contributor", None)
    if callable(register_result):
        register_result(AG99liveRemoteOperatorResultContributor())


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

    computers = _resolve_computers(config)
    if not computers:
        return None

    default_computer = _normalize_key(config.get("remote_operator_default_computer"))
    if default_computer not in computers:
        default_computer = next(iter(computers))

    return RemoteOperatorConfig(
        default_computer=default_computer,
        computers=computers,
        default_profile=_resolve_default_profile(config),
        profiles=_resolve_profile_labels(config),
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
        default_profile=config.default_profile,
        profiles=config.profiles,
    )


def build_remote_operator_prompt(config: RemoteOperatorConfig) -> str:
    lines = [
        "当用户明确要求操作电脑、打开软件、使用浏览器、检查本机项目或让远程执行器完成任务时，生成远程执行器请求。",
        "远程执行器请求只能包含三个字段：",
        '{"computer":"<computer_key>","profile":"simple|complex","prompt":"<交给远程执行器的完整任务说明>"}',
        "不要输出底层点击、坐标、键盘、UIA selector 或 shell 步骤；这些由远程执行器自行决定。",
        f"如果用户没有指定电脑，computer 使用默认电脑 `{config.default_computer}`。",
        f"如果用户没有明确要求复杂/深入/高档执行，profile 必须使用默认档位 `{config.default_profile}`。",
        "只有当用户明确要求复杂任务、深入排查、高档、高思考、复杂代码修改或大范围重构时，profile 才使用 `complex`；不要自行因为任务看起来复杂就升档。",
        "可用电脑名称映射：",
    ]
    for key, label in config.computers.items():
        default_suffix = "（默认）" if key == config.default_computer else ""
        lines.append(f"- {label} -> {key}{default_suffix}")
    lines.append("可用执行档位：")
    for key, label in config.profiles.items():
        default_suffix = "（默认）" if key == config.default_profile else ""
        lines.append(f"- {label} -> {key}{default_suffix}")
    return "\n".join(lines)


def parse_remote_operator_request_from_view(
    event: Any,
    view: Any,
) -> tuple[Any | None, str]:
    if not _is_ag99live_event(event):
        return None, "non_ag99live_event"
    if _is_remote_operator_result_event(event):
        return None, "remote_operator_result_event"

    text = _extract_assistant_text(view)
    if not text:
        return None, "assistant_text_empty"

    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        return None, "assistant_text_not_json"
    if not isinstance(payload, dict):
        return None, "payload_not_object"
    if set(payload.keys()) != {"computer", "profile", "prompt"}:
        return None, "payload_keys_invalid"

    computer = _normalize_key(payload.get("computer"))
    profile = _normalize_profile(payload.get("profile"))
    prompt = str(payload.get("prompt") or "").strip()
    if not computer:
        return None, "computer_empty"
    if not profile:
        return None, "profile_empty"
    if not prompt:
        return None, "prompt_empty"

    config = resolve_remote_operator_config(_load_plugin_config())
    if config is None:
        return None, "config_unavailable"
    online_config = filter_online_remote_operator_config(config)
    if online_config is None:
        return None, "no_online_computer"
    if computer not in online_config.computers:
        return None, "computer_unavailable"
    if profile not in online_config.profiles:
        return None, "profile_unavailable"

    from ..services.remote_operator_runtime import RemoteOperatorRequest

    return RemoteOperatorRequest(computer=computer, profile=profile, prompt=prompt), "ok"


def _normalize_computers(value: Any) -> dict[str, str]:
    value = _coerce_json_mapping(value)
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


def _resolve_computers(config: Mapping[str, Any]) -> dict[str, str]:
    entries = config.get("remote_operator_computer_entries")
    computers: dict[str, str] = {}
    if isinstance(entries, list):
        for item in entries:
            if not isinstance(item, Mapping):
                continue
            key = _normalize_key(item.get("key"))
            label = str(item.get("label") or "").strip()
            endpoint = str(item.get("endpoint") or "").strip()
            if key and label and endpoint and key not in computers:
                computers[key] = label
    if computers:
        return computers
    return _normalize_computers(config.get("remote_operator_computers"))


def _normalize_key(value: Any) -> str:
    return str(value or "").strip()


def _normalize_profile(value: Any) -> str:
    normalized = str(value or "").strip()
    if normalized in {"simple", "complex"}:
        return normalized
    return ""


def _resolve_default_profile(config: Mapping[str, Any]) -> str:
    profile = _normalize_profile(config.get("remote_operator_default_profile"))
    return profile or "simple"


def _resolve_profile_labels(config: Mapping[str, Any]) -> dict[str, str]:
    labels = {
        "simple": "简单任务",
        "complex": "复杂任务",
    }
    raw_profiles = _coerce_json_mapping(config.get("remote_operator_profiles"))
    if isinstance(raw_profiles, Mapping):
        for key in ("simple", "complex"):
            raw_profile = raw_profiles.get(key)
            if not isinstance(raw_profile, Mapping):
                continue
            label = str(raw_profile.get("label") or "").strip()
            if label:
                labels[key] = label
    return labels


def _coerce_json_mapping(value: Any) -> Any:
    if isinstance(value, Mapping):
        return value
    if not isinstance(value, str) or not value.strip():
        return value
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return value
    return parsed if isinstance(parsed, Mapping) else value


def _is_ag99live_event(event: Any) -> bool:
    platform_id = _call_event_method(event, "get_platform_id")
    platform_name = _call_event_method(event, "get_platform_name")
    return platform_id == "olv_pet_adapter" or platform_name == "olv_pet_adapter"


def _is_remote_operator_result_event(event: Any) -> bool:
    if _get_event_extra(event, "ag99live_input_source") == "remote_operator_result":
        return True
    message_obj = getattr(event, "message_obj", None)
    raw_message = getattr(message_obj, "raw_message", None)
    if isinstance(raw_message, Mapping):
        return raw_message.get("ag99live_input_source") == "remote_operator_result"
    return False


def _get_event_extra(event: Any, key: str) -> Any:
    method = getattr(event, "get_extra", None)
    if not callable(method):
        return None
    try:
        return method(key)
    except Exception:
        return None


def _extract_assistant_text(view: Any) -> str:
    for attr in ("final_result", "core_result"):
        value = getattr(view, attr, None)
        text = str(value or "").strip()
        if text:
            return text
    return ""


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
