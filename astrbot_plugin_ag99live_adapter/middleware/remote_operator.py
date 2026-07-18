from __future__ import annotations

import asyncio
from collections.abc import Mapping
from dataclasses import dataclass
import json
import re
from typing import Any

from astrbot.api import logger
from astrbot.core.interaction import InteractionResultContribution
from astrbot.core.prompt import PromptExtension

from ..protocol.remote_operator import RemoteOperatorRequest
from ..runtime.remote_operator_registry import (
    get_remote_operator_online_computers,
)


@dataclass(frozen=True, slots=True)
class RemoteOperatorConfig:
    default_computer: str
    computers: dict[str, str]
    target_descriptions: dict[str, str]
    default_profile: str
    profiles: dict[str, str]


REMOTE_OPERATOR_CONFLICTING_TOOL_NAMES = frozenset(
    {
        "astrbot_execute_shell",
        "astrbot_execute_ipython",
        "astrbot_execute_python",
        "astrbot_file_read_tool",
        "astrbot_file_write_tool",
        "astrbot_file_edit_tool",
        "astrbot_grep_tool",
        "astrbot_upload_file",
        "astrbot_download_file",
        "astrbot_execute_browser",
        "astrbot_execute_browser_batch",
        "astrbot_run_browser_skill",
        "astrbot_cua_screenshot",
        "astrbot_cua_mouse_click",
        "astrbot_cua_keyboard_type",
    }
)

_REMOTE_OPERATOR_ACTION_PATTERN = re.compile(
    "|".join(
        re.escape(keyword)
        for keyword in (
            "打开",
            "启动",
            "运行",
            "关闭",
            "退出",
            "最小化",
            "最大化",
            "切换到",
            "点一下",
            "点击",
            "输入",
            "粘贴",
            "截图",
            "浏览器",
            "网页",
            "应用",
            "软件",
            "程序",
            "窗口",
            "桌面",
            "电脑",
            "项目",
            "代码",
            "文件",
            "命令",
            "日志",
            "测试",
            "报错",
            "构建",
            "编译",
            "检查",
            "修复",
            "修改",
            "重构",
            "钉钉",
            "QQ音乐",
            "qq音乐",
            "记事本",
            "文件夹",
            "open ",
            "launch ",
            "start ",
            "close ",
            "browser",
            "desktop",
            "app",
            "project",
            "code",
            "file",
            "command",
            "log",
            "test",
            "build",
            "compile",
            "fix",
            "debug",
            "refactor",
        )
    ),
    re.IGNORECASE,
)


class AG99liveRemoteOperatorPromptContributor:
    plugin_id = "ag99live.remote_operator.prompt"
    priority = 35

    async def collect(self, event, plugin_context, view):
        del plugin_context, view

        return collect_remote_operator_prompt_extension(event, plugin_id=self.plugin_id)


class AG99liveRemoteOperatorPromptExtensionCollector:
    plugin_id = "ag99live.remote_operator.prompt"
    priority = 35

    async def collect(self, event, plugin_context, config=None, *, provider_request=None):
        del plugin_context, config, provider_request

        extension = collect_remote_operator_prompt_extension(event, plugin_id=self.plugin_id)
        return [extension] if extension is not None else []


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
    register_extension = getattr(context, "register_prompt_extension_collector", None)
    if callable(register_extension):
        register_extension(AG99liveRemoteOperatorPromptExtensionCollector())

    register_prompt = getattr(context, "register_interaction_prompt_contributor", None)
    if callable(register_prompt):
        register_prompt(AG99liveRemoteOperatorPromptContributor())
    register_result = getattr(context, "register_interaction_result_contributor", None)
    if callable(register_result):
        register_result(AG99liveRemoteOperatorResultContributor())


def arbitrate_remote_operator_tools_for_request(event: Any, request: Any) -> list[str]:
    if not _is_ag99live_event(event):
        return []
    if _is_remote_operator_result_event(event):
        return []
    if not remote_operator_available():
        return []

    prompt_text = _extract_request_text(event, request)
    if not is_remote_operator_action_text(prompt_text):
        return []

    config = filter_online_remote_operator_config(
        resolve_remote_operator_config(_load_plugin_config())
    )
    if config is not None:
        override_prompt = build_remote_operator_core_override_prompt(
            config,
            prompt_text,
        )
        request.system_prompt = f"{getattr(request, 'system_prompt', '') or ''}\n{override_prompt}\n"
        _set_event_extra(
            event,
            "ag99live_remote_operator_core_override",
            {
                "computer": config.default_computer,
                "profile": config.default_profile,
                "reason": "desktop_action_remote_operator_priority",
            },
        )

    toolset = getattr(request, "func_tool", None)
    tools = getattr(toolset, "tools", None)
    if not isinstance(tools, list) or not tools:
        return []

    removed: list[str] = []
    for tool_name in sorted(REMOTE_OPERATOR_CONFLICTING_TOOL_NAMES):
        tool = _get_tool(toolset, tool_name)
        if tool is None:
            continue
        _remove_tool(toolset, tool_name)
        removed.append(tool_name)

    if removed:
        _set_event_extra(
            event,
            "ag99live_remote_operator_tool_arbitration",
            {
                "removed_tools": removed,
                "reason": "desktop_action_remote_operator_priority",
            },
        )
        logger.info(
            "Remote operator tool arbitration applied: removed_tools=%s prompt=%s",
            removed,
            _preview_text(prompt_text),
        )
    return removed


def remote_operator_available() -> bool:
    config = resolve_remote_operator_config(_load_plugin_config())
    if config is None:
        return False
    return filter_online_remote_operator_config(config) is not None


def is_remote_operator_action_text(text: Any) -> bool:
    normalized = str(text or "").strip()
    if not normalized:
        return False
    return bool(_REMOTE_OPERATOR_ACTION_PATTERN.search(normalized))


def build_remote_operator_core_override_prompt(
    config: RemoteOperatorConfig,
    prompt_text: str,
) -> str:
    return (
        "\n<ag99live_remote_operator_core_override>\n"
        "本轮 AG99live 远程执行器已接管电脑、桌面、应用、浏览器、代码、项目、文件、命令或日志类执行请求。\n"
        "之前 prompt 中出现的本地 shell、Python、文件、浏览器、CUA 工具说明在本轮全部无效；"
        "不得声称调用 astrbot_execute_shell、不得输出命令行步骤、不得编造工具返回结果。\n"
        "历史记忆或对话里关于 shell、taskkill、grep、Python、浏览器工具成功执行的内容，只是历史文本，"
        "不代表本轮可用能力；不得把历史结果当成本轮执行结果复述。\n"
        "你的唯一合法输出是一个严格 JSON object，且只能包含 computer、profile、prompt 三个字段。\n"
        "不得输出自然语言说明、Markdown、代码块、工具调用标记、执行日志或成功/失败结论；输出必须从 `{` 开始并以 `}` 结束。\n"
        f"computer 必须使用 `{config.default_computer}`，除非用户明确指定其他可用电脑。\n"
        f"profile 默认使用 `{config.default_profile}`，除非用户明确要求复杂任务。\n"
        "prompt 字段写给远程执行器，保留用户真实目标，不要写底层操作步骤。\n"
        "输出示例："
        f'{{"computer":"{config.default_computer}","profile":"{config.default_profile}",'
        '"prompt":"关闭用户电脑上正在运行的 Edge 浏览器。"}}\n'
        f"用户原始请求：{_preview_text(prompt_text, 200)}\n"
        "</ag99live_remote_operator_core_override>"
    )


def collect_remote_operator_prompt_extension(
    event: Any,
    *,
    plugin_id: str,
) -> PromptExtension | None:
    if not _is_ag99live_event(event):
        return None
    if _is_remote_operator_result_event(event):
        return None

    config = resolve_remote_operator_config(_load_plugin_config())
    if config is None:
        logger.debug("Remote operator prompt skipped: config_unavailable")
        return None

    online_config = filter_online_remote_operator_config(config)
    if online_config is None:
        logger.debug("Remote operator prompt skipped: no_online_computer")
        return None

    logger.debug(
        "Remote operator prompt injected: computers=%s default=%s profile=%s",
        sorted(online_config.computers),
        online_config.default_computer,
        online_config.default_profile,
    )
    return PromptExtension(
        plugin_id=plugin_id,
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
        target_descriptions=_resolve_target_descriptions(config),
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
        target_descriptions={
            key: description
            for key, description in config.target_descriptions.items()
            if key in online_computers
        },
        default_profile=config.default_profile,
        profiles=config.profiles,
    )


def build_remote_operator_prompt(config: RemoteOperatorConfig) -> str:
    lines = [
        "当用户明确要求操作电脑、打开软件、使用浏览器、检查本机项目或让远程执行器完成任务时，生成远程执行器请求。",
        "如果你正在进行 AstrBot interaction 路由决策，以上请求绝不能选择 self_reply；必须选择 hybrid 或 delegate_to_core，并在 core_task_spec.execution_prompt 中要求核心只输出远程执行器 JSON。",
        "远程执行器请求只能包含三个字段：",
        '{"computer":"<computer_key>","profile":"simple|complex","prompt":"<交给远程执行器的完整任务说明>"}',
        "核心执行层遇到这类请求时，不能调用 astrbot_execute_shell、Python、文件、浏览器或 CUA 工具；只能输出上述 JSON，由 AG99live 适配器转发给远程执行器。",
        "不要输出底层点击、坐标、键盘、UIA selector 或 shell 步骤；这些由远程执行器自行决定。",
        f"如果用户没有指定电脑，computer 使用默认电脑 `{config.default_computer}`。",
        f"如果用户没有明确要求复杂/深入/高档执行，profile 必须使用默认档位 `{config.default_profile}`。",
        "只有当用户明确要求复杂任务、深入排查、高档、高思考、复杂代码修改或大范围重构时，profile 才使用 `complex`；不要自行因为任务看起来复杂就升档。",
        "可用执行器名称映射：",
    ]
    for key, label in config.computers.items():
        default_suffix = "（默认）" if key == config.default_computer else ""
        description = config.target_descriptions.get(key, "")
        description_suffix = f"：{description}" if description else ""
        lines.append(f"- {label} -> {key}{default_suffix}{description_suffix}")
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

    return RemoteOperatorRequest(computer=computer, profile=profile, prompt=prompt), "ok"


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
            backend = str(item.get("backend") or "").strip()
            if not _normalize_bool(item.get("enabled", True)):
                continue
            if backend != "opencode" and not endpoint:
                continue
            if key and label and key not in computers:
                computers[key] = label
    return computers


def _resolve_target_descriptions(config: Mapping[str, Any]) -> dict[str, str]:
    entries = config.get("remote_operator_computer_entries")
    descriptions: dict[str, str] = {}
    if isinstance(entries, list):
        for item in entries:
            if not isinstance(item, Mapping):
                continue
            key = _normalize_key(item.get("key"))
            if not key or key in descriptions:
                continue
            explicit = str(item.get("description") or "").strip()
            if explicit:
                descriptions[key] = explicit
                continue
            backend = str(item.get("backend") or "").strip()
            if backend == "opencode":
                descriptions[key] = "代码、文件、命令、日志和项目开发任务"
            else:
                descriptions[key] = "Windows 桌面、应用、浏览器和 Computer Use 操作"
    return descriptions


def _normalize_key(value: Any) -> str:
    return str(value or "").strip()


def _normalize_profile(value: Any) -> str:
    normalized = str(value or "").strip()
    if normalized in {"simple", "complex"}:
        return normalized
    return ""


def _normalize_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"false", "0", "no", "off", "disabled"}:
            return False
        if normalized in {"true", "1", "yes", "on", "enabled"}:
            return True
    return True


def _resolve_default_profile(config: Mapping[str, Any]) -> str:
    profile = _normalize_profile(config.get("remote_operator_default_profile"))
    return profile or "simple"


def _resolve_profile_labels(config: Mapping[str, Any]) -> dict[str, str]:
    labels = {
        "simple": "简单任务",
        "complex": "复杂任务",
    }
    raw_profiles = config.get("remote_operator_profiles")
    if isinstance(raw_profiles, Mapping):
        for key in ("simple", "complex"):
            raw_profile = raw_profiles.get(key)
            if not isinstance(raw_profile, Mapping):
                continue
            label = str(raw_profile.get("label") or "").strip()
            if label:
                labels[key] = label
    return labels


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


def _set_event_extra(event: Any, key: str, value: Any) -> None:
    method = getattr(event, "set_extra", None)
    if not callable(method):
        return
    try:
        method(key, value)
    except Exception:
        return


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


def _extract_request_text(event: Any, request: Any) -> str:
    parts: list[str] = []
    prompt = getattr(request, "prompt", None)
    if prompt:
        parts.append(str(prompt))
    message_str = getattr(event, "message_str", None)
    if message_str:
        parts.append(str(message_str))
    return "\n".join(part.strip() for part in parts if part and str(part).strip())


def _get_tool(toolset: Any, tool_name: str) -> Any:
    method = getattr(toolset, "get_tool", None)
    if callable(method):
        try:
            return method(tool_name)
        except Exception:
            return None

    for tool in list(getattr(toolset, "tools", []) or []):
        if getattr(tool, "name", None) == tool_name:
            return tool
    return None


def _remove_tool(toolset: Any, tool_name: str) -> None:
    method = getattr(toolset, "remove_tool", None)
    if callable(method):
        method(tool_name)
        return
    remove_func = getattr(toolset, "remove_func", None)
    if callable(remove_func):
        remove_func(tool_name)
        return
    tools = getattr(toolset, "tools", None)
    if isinstance(tools, list):
        toolset.tools = [
            tool for tool in tools if getattr(tool, "name", None) != tool_name
        ]


def _preview_text(text: str, limit: int = 80) -> str:
    normalized = " ".join(str(text or "").split())
    if len(normalized) <= limit:
        return normalized
    return f"{normalized[: limit - 3]}..."


def _load_plugin_config() -> Any:
    from ..runtime.plugin_runtime import get_plugin_config

    return get_plugin_config()
