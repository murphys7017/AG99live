from __future__ import annotations

import asyncio
import json
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Awaitable, Callable
from uuid import uuid4

from astrbot.api import logger

from ..middleware.remote_operator import (
    mark_remote_operator_computer_offline,
    mark_remote_operator_computer_online,
    set_remote_operator_online_computers,
)


@dataclass(frozen=True, slots=True)
class RemoteOperatorEndpointConfig:
    default_computer: str
    computers: dict[str, str]
    endpoints: dict[str, str]
    default_profile: str
    profiles: dict[str, "RemoteOperatorProfile"]


@dataclass(frozen=True, slots=True)
class RemoteOperatorRequest:
    computer: str
    profile: str
    prompt: str


@dataclass(frozen=True, slots=True)
class RemoteOperatorProfile:
    label: str
    model: str
    effort: str


@dataclass(frozen=True, slots=True)
class RemoteOperatorExecutionResult:
    computer: str
    profile: str
    prompt: str
    status: str
    result: str = ""
    error: str = ""


def resolve_remote_operator_endpoint_config(
    config: Any,
) -> RemoteOperatorEndpointConfig | None:
    if not isinstance(config, Mapping):
        return None

    computers, endpoints = _resolve_computer_entries(config)
    if not computers or not endpoints:
        return None

    available = {
        key: label
        for key, label in computers.items()
        if key in endpoints
    }
    if not available:
        return None

    profiles = _resolve_profiles(config.get("remote_operator_profiles"))
    default_profile = _normalize_text(config.get("remote_operator_default_profile"))
    if default_profile not in profiles:
        default_profile = "simple"

    default_computer = _normalize_text(config.get("remote_operator_default_computer"))
    if default_computer not in available:
        default_computer = next(iter(available))

    return RemoteOperatorEndpointConfig(
        default_computer=default_computer,
        computers=available,
        endpoints={key: endpoints[key] for key in available},
        default_profile=default_profile,
        profiles=profiles,
    )


class CodexAppServerClient:
    def __init__(
        self,
        endpoint: str,
        *,
        timeout_seconds: float = 60.0,
    ) -> None:
        self.endpoint = endpoint
        self.timeout_seconds = max(float(timeout_seconds or 60.0), 1.0)

    async def probe(self) -> bool:
        try:
            await asyncio.wait_for(self._handshake_only(), timeout=5.0)
            return True
        except Exception as exc:  # noqa: BLE001
            logger.debug(
                "Remote operator endpoint probe failed: endpoint=%s error=%s",
                self.endpoint,
                exc,
            )
            return False

    async def execute(
        self,
        prompt: str,
        *,
        model: str | None = None,
        effort: str | None = None,
    ) -> str:
        return await asyncio.wait_for(
            self._execute_unbounded(prompt, model=model, effort=effort),
            timeout=self.timeout_seconds,
        )

    async def _handshake_only(self) -> None:
        import websockets  # type: ignore

        async with websockets.connect(self.endpoint) as websocket:
            await self._initialize(websocket)

    async def _execute_unbounded(
        self,
        prompt: str,
        *,
        model: str | None = None,
        effort: str | None = None,
    ) -> str:
        import websockets  # type: ignore

        async with websockets.connect(self.endpoint) as websocket:
            return await self._execute_unbounded_with_websocket(
                websocket,
                prompt,
                model=model,
                effort=effort,
            )

    async def _execute_unbounded_with_websocket(
        self,
        websocket: Any,
        prompt: str,
        *,
        model: str | None = None,
        effort: str | None = None,
    ) -> str:
        await self._initialize(websocket)
        thread_id = await self._start_thread(websocket)
        return await self._start_turn(
            websocket,
            thread_id=thread_id,
            prompt=prompt,
            model=model,
            effort=effort,
        )

    async def _initialize(self, websocket: Any) -> None:
        request_id = uuid4().hex
        await websocket.send(
            json.dumps(
                {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "method": "initialize",
                    "params": {},
                }
            )
        )
        while True:
            message = await websocket.recv()
            payload = _loads_json_object(message)
            if payload.get("id") == request_id:
                error = payload.get("error")
                if isinstance(error, Mapping):
                    raise RuntimeError(str(error.get("message") or error))
                await websocket.send(
                    json.dumps({"jsonrpc": "2.0", "method": "initialized"})
                )
                return

    async def _start_thread(self, websocket: Any) -> str:
        request_id = uuid4().hex
        await websocket.send(
            json.dumps(
                {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "method": "thread/start",
                    "params": {},
                }
            )
        )
        while True:
            payload = _loads_json_object(await websocket.recv())
            if payload.get("id") != request_id:
                continue
            error = payload.get("error")
            if isinstance(error, Mapping):
                raise RuntimeError(str(error.get("message") or error))
            result = payload.get("result")
            if not isinstance(result, Mapping):
                raise RuntimeError("thread/start returned no result object")
            thread_id = _extract_thread_id(result)
            if not thread_id:
                raise RuntimeError("thread/start returned no thread id")
            return thread_id

    async def _start_turn(
        self,
        websocket: Any,
        *,
        thread_id: str,
        prompt: str,
        model: str | None = None,
        effort: str | None = None,
    ) -> str:
        request_id = uuid4().hex
        params: dict[str, Any] = {
            "threadId": thread_id,
            "input": [
                {
                    "type": "text",
                    "text": prompt,
                }
            ],
        }
        if model:
            params["model"] = model
        if effort:
            params["effort"] = effort
        await websocket.send(
            json.dumps(
                {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "method": "turn/start",
                    "params": params,
                }
            )
        )

        collected: list[str] = []
        while True:
            payload = _loads_json_object(await websocket.recv())
            if payload.get("id") == request_id and isinstance(payload.get("error"), Mapping):
                error = payload["error"]
                raise RuntimeError(str(error.get("message") or error))

            method = str(payload.get("method") or "").strip()
            params = payload.get("params")
            result = payload.get("result")
            event_payload = params if isinstance(params, Mapping) else result
            if isinstance(event_payload, Mapping):
                text = _extract_event_text(event_payload)
                if text:
                    collected.append(text)

            if method in {"turn/completed", "turn/failed"}:
                break
            if method in {"approval/requested", "exec/approval/requested"}:
                raise RuntimeError("codex app-server requested approval; v1 remote operator refuses approval-gated actions")

        return "\n".join(_dedupe_keep_order(collected)).strip()


class RemoteOperatorRuntime:
    def __init__(
        self,
        *,
        plugin_config_loader: Callable[[], Any],
        submit_system_text_input: Callable[[str, dict[str, Any]], Awaitable[None]],
        client_factory: Callable[[str], CodexAppServerClient] | None = None,
        probe_interval_seconds: float = 15.0,
    ) -> None:
        self._plugin_config_loader = plugin_config_loader
        self._submit_system_text_input = submit_system_text_input
        self._client_factory = client_factory or (lambda endpoint: CodexAppServerClient(endpoint))
        self._probe_interval_seconds = max(float(probe_interval_seconds or 15.0), 1.0)
        self._task: asyncio.Task[Any] | None = None
        self._stopped = asyncio.Event()

    def start(self) -> None:
        if self._task is not None and not self._task.done():
            return
        self._stopped.clear()
        self._task = asyncio.create_task(self._run_probe_loop())

    async def stop(self) -> None:
        self._stopped.set()
        task = self._task
        if task is not None:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        self._task = None
        set_remote_operator_online_computers([])

    async def refresh_online_once(self) -> set[str]:
        config = resolve_remote_operator_endpoint_config(self._plugin_config_loader())
        if config is None:
            set_remote_operator_online_computers([])
            return set()

        online: set[str] = set()
        for computer, endpoint in config.endpoints.items():
            if await self._client_factory(endpoint).probe():
                online.add(computer)
                mark_remote_operator_computer_online(computer)
            else:
                mark_remote_operator_computer_offline(computer)
        set_remote_operator_online_computers(online)
        return online

    async def execute_and_submit(self, request: RemoteOperatorRequest) -> None:
        result = await self.execute(request)
        await self._submit_result(result)

    async def execute(self, request: RemoteOperatorRequest) -> RemoteOperatorExecutionResult:
        config = resolve_remote_operator_endpoint_config(self._plugin_config_loader())
        if config is None or request.computer not in config.endpoints:
            return RemoteOperatorExecutionResult(
                computer=request.computer,
                profile=request.profile,
                prompt=request.prompt,
                status="failed",
                error="remote_operator_endpoint_unavailable",
            )
        profile = config.profiles.get(request.profile)
        if profile is None:
            return RemoteOperatorExecutionResult(
                computer=request.computer,
                profile=request.profile,
                prompt=request.prompt,
                status="failed",
                error="remote_operator_profile_unavailable",
            )
        try:
            output = await self._client_factory(config.endpoints[request.computer]).execute(
                request.prompt,
                model=profile.model,
                effort=profile.effort,
            )
        except Exception as exc:  # noqa: BLE001
            mark_remote_operator_computer_offline(request.computer)
            return RemoteOperatorExecutionResult(
                computer=request.computer,
                profile=request.profile,
                prompt=request.prompt,
                status="failed",
                error=str(exc),
            )
        mark_remote_operator_computer_online(request.computer)
        return RemoteOperatorExecutionResult(
            computer=request.computer,
            profile=request.profile,
            prompt=request.prompt,
            status="completed",
            result=output or "远程执行器已完成，但没有返回文本结果。",
        )

    async def _submit_result(self, result: RemoteOperatorExecutionResult) -> None:
        text = _format_result_text(result)
        await self._submit_system_text_input(
            text,
            {
                "ag99live_input_source": "remote_operator_result",
                "remote_operator": {
                    "computer": result.computer,
                    "profile": result.profile,
                    "prompt": result.prompt,
                    "status": result.status,
                    "result": result.result,
                    "error": result.error,
                },
            },
        )

    async def _run_probe_loop(self) -> None:
        while not self._stopped.is_set():
            try:
                await self.refresh_online_once()
            except Exception as exc:  # noqa: BLE001
                logger.warning("Remote operator endpoint refresh failed: %s", exc)
            try:
                await asyncio.wait_for(
                    self._stopped.wait(),
                    timeout=self._probe_interval_seconds,
                )
            except asyncio.TimeoutError:
                continue


def _format_result_text(result: RemoteOperatorExecutionResult) -> str:
    lines = [
        "[系统级输入：远程执行器结果]",
        f"电脑：{result.computer}",
        f"执行状态：{result.status}",
        "原始任务：",
        result.prompt,
    ]
    if result.status == "completed":
        lines.extend(["执行结果：", result.result or "远程执行器已完成，但没有返回文本结果。"])
    else:
        lines.extend(["执行错误：", result.error or "远程执行失败。"])
    return "\n".join(lines)


def _normalize_mapping(value: Any) -> dict[str, str]:
    value = _coerce_json_mapping(value)
    if not isinstance(value, Mapping):
        return {}
    result: dict[str, str] = {}
    for raw_key, raw_value in value.items():
        key = _normalize_text(raw_key)
        item = _normalize_text(raw_value)
        if key and item and key not in result:
            result[key] = item
    return result


def _resolve_computer_entries(config: Mapping[str, Any]) -> tuple[dict[str, str], dict[str, str]]:
    entries = config.get("remote_operator_computer_entries")
    computers: dict[str, str] = {}
    endpoints: dict[str, str] = {}
    if isinstance(entries, list):
        for item in entries:
            if not isinstance(item, Mapping):
                continue
            key = _normalize_text(item.get("key"))
            label = _normalize_text(item.get("label"))
            endpoint = _normalize_text(item.get("endpoint"))
            if not key or not label or not endpoint:
                continue
            if key in computers:
                continue
            computers[key] = label
            endpoints[key] = endpoint
    if computers and endpoints:
        return computers, endpoints
    return (
        _normalize_mapping(config.get("remote_operator_computers")),
        _normalize_mapping(config.get("remote_operator_endpoints")),
    )


def _resolve_profiles(value: Any) -> dict[str, RemoteOperatorProfile]:
    defaults = {
        "simple": RemoteOperatorProfile(
            label="简单任务",
            model="gpt-5.3-codex",
            effort="low",
        ),
        "complex": RemoteOperatorProfile(
            label="复杂任务",
            model="gpt-5.4-codex",
            effort="high",
        ),
    }
    value = _coerce_json_mapping(value)
    if not isinstance(value, Mapping):
        return defaults

    profiles = dict(defaults)
    for raw_key, raw_profile in value.items():
        key = _normalize_text(raw_key)
        if key not in {"simple", "complex"} or not isinstance(raw_profile, Mapping):
            continue
        label = _normalize_text(raw_profile.get("label")) or defaults[key].label
        model = _normalize_text(raw_profile.get("model")) or defaults[key].model
        effort = _normalize_text(raw_profile.get("effort")) or defaults[key].effort
        if effort not in {"none", "minimal", "low", "medium", "high", "xhigh"}:
            effort = defaults[key].effort
        profiles[key] = RemoteOperatorProfile(
            label=label,
            model=model,
            effort=effort,
        )
    return profiles


def _normalize_text(value: Any) -> str:
    return str(value or "").strip()


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


def _loads_json_object(message: Any) -> dict[str, Any]:
    payload = json.loads(str(message))
    if not isinstance(payload, dict):
        raise RuntimeError("codex app-server returned non-object JSON")
    return payload


def _first_text(mapping: Mapping[str, Any], keys: tuple[str, ...]) -> str:
    for key in keys:
        value = mapping.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def _extract_thread_id(result: Mapping[str, Any]) -> str:
    direct = _first_text(
        result,
        ("threadId", "thread_id", "id", "conversationId", "conversation_id"),
    )
    if direct:
        return direct
    thread = result.get("thread")
    if isinstance(thread, Mapping):
        nested = _first_text(
            thread,
            ("id", "threadId", "thread_id", "conversationId", "conversation_id"),
        )
        if nested:
            return nested
    return ""


def _extract_event_text(payload: Mapping[str, Any]) -> str:
    direct = _first_text(
        payload,
        (
            "text",
            "delta",
            "message",
            "content",
            "output",
            "summary",
        ),
    )
    if direct:
        return direct
    item = payload.get("item")
    if isinstance(item, Mapping):
        return _extract_event_text(item)
    data = payload.get("data")
    if isinstance(data, Mapping):
        return _extract_event_text(data)
    return ""


def _dedupe_keep_order(values: list[str]) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for value in values:
        normalized = value.strip()
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        result.append(normalized)
    return result
