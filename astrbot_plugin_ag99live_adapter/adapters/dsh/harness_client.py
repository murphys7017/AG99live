"""Async stdio client for the DeepSeek Harness SDK JSON-RPC runtime."""

from __future__ import annotations

import asyncio
import json
import os
import shutil
from collections.abc import AsyncIterator, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from uuid import uuid4


@dataclass(frozen=True)
class DshHarnessConfig:
    dsh_bin: str
    dsh_home: str
    profile: str = "sdk"
    workspace: str = ""
    provider: str = "deepseek-official"
    model: str = "deepseek-v4-flash"
    reasoning_effort: str | None = None
    max_tokens: int | None = None
    request_timeout_seconds: float | None = None
    environment: Mapping[str, str] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not str(self.dsh_bin or "").strip():
            raise ValueError("dsh_bin_required")
        if not str(self.dsh_home or "").strip():
            raise ValueError("dsh_home_required")
        if not str(self.profile or "").strip():
            raise ValueError("dsh_profile_required")
        if not str(self.provider or "").strip():
            raise ValueError("dsh_provider_required")
        if not str(self.model or "").strip():
            raise ValueError("dsh_model_required")


class DshHarnessClient:
    """One reusable DSH runtime process with per-session notification queues."""

    def __init__(self, config: DshHarnessConfig) -> None:
        self.config = config
        self._process: asyncio.subprocess.Process | None = None
        self._reader_task: asyncio.Task[None] | None = None
        self._stderr_task: asyncio.Task[None] | None = None
        self._write_lock = asyncio.Lock()
        self._pending: dict[str, asyncio.Future[Any]] = {}
        self._session_queues: dict[str, asyncio.Queue[dict[str, Any]]] = {}
        self._start_lock = asyncio.Lock()
        self._closed = False

    async def start(self) -> None:
        if self._closed:
            raise RuntimeError("dsh_harness_client_closed")
        if self._process is not None:
            return
        async with self._start_lock:
            if self._process is not None:
                return
            env = os.environ.copy()
            env.update({str(key): str(value) for key, value in self.config.environment.items()})
            env["DSH_HOME"] = str(Path(self.config.dsh_home).expanduser().resolve())
            executable = str(Path(self.config.dsh_bin).expanduser())
            if not Path(executable).exists():
                executable = shutil.which(executable) or executable
            args = [
                executable,
                "--profile",
                str(self.config.profile),
            ]
            self._process = await asyncio.create_subprocess_exec(
                *args,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=(
                    str(Path(self.config.workspace).expanduser().resolve())
                    if self.config.workspace.strip()
                    else None
                ),
                env=env,
            )
            self._reader_task = asyncio.create_task(
                self._reader_loop(),
                name="ag99live-dsh-jsonrpc-reader",
            )
            self._stderr_task = asyncio.create_task(
                self._drain_stderr(),
                name="ag99live-dsh-stderr-drain",
            )
            try:
                await self.request(
                    "initialize",
                    {
                        "cwd": str(
                            Path(self.config.workspace or Path.cwd())
                            .expanduser()
                            .resolve()
                        ),
                        "provider": self.config.provider,
                        "model": self.config.model,
                        **(
                            {"reasoningEffort": self.config.reasoning_effort}
                            if self.config.reasoning_effort
                            else {}
                        ),
                        **(
                            {"maxTokens": self.config.max_tokens}
                            if self.config.max_tokens is not None
                            else {}
                        ),
                    },
                )
            except Exception:
                await self._terminate_process()
                raise

    async def prompt(
        self,
        *,
        session_id: str,
        text: str,
        metadata: Mapping[str, Any] | None = None,
    ) -> AsyncIterator[dict[str, Any]]:
        await self.start()
        queue = self._session_queues.setdefault(session_id, asyncio.Queue())
        request_id = await self.request_no_wait(
            "session/prompt",
            {
                "sessionId": session_id,
                "contentBlocks": [{"type": "text", "text": text}],
                **(
                    {"metadata": dict(metadata)}
                    if isinstance(metadata, Mapping) and metadata
                    else {}
                ),
            },
        )
        prompt_response: asyncio.Future[Any] | None = self._pending.get(request_id)
        deadline = (
            asyncio.get_running_loop().time() + self.config.request_timeout_seconds
            if self.config.request_timeout_seconds is not None
            else None
        )
        try:
            while True:
                if deadline is None:
                    notification = await queue.get()
                else:
                    remaining = deadline - asyncio.get_running_loop().time()
                    if remaining <= 0:
                        raise TimeoutError("dsh_session_prompt_timeout")
                    try:
                        notification = await asyncio.wait_for(queue.get(), timeout=remaining)
                    except asyncio.TimeoutError as exc:
                        raise TimeoutError("dsh_session_prompt_timeout") from exc
                method = str(notification.get("method") or "")
                payload = notification.get("params")
                payload = payload if isinstance(payload, Mapping) else {}
                if method == "session.status" and payload.get("status") == "idle":
                    if prompt_response is not None:
                        await prompt_response
                    return
                if method == "session.event":
                    event = payload.get("event")
                    if isinstance(event, Mapping):
                        yield dict(event)
        finally:
            self._pending.pop(request_id, None)

    async def request_no_wait(self, method: str, params: Mapping[str, Any] | None) -> str:
        if self._process is None or self._process.stdin is None:
            raise RuntimeError("dsh_harness_not_running")
        request_id = uuid4().hex
        future = asyncio.get_running_loop().create_future()
        self._pending[request_id] = future
        await self._write(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "method": method,
                **({"params": dict(params)} if params is not None else {}),
            }
        )
        return request_id

    async def request(self, method: str, params: Mapping[str, Any] | None) -> Any:
        request_id = await self.request_no_wait(method, params)
        future = self._pending.get(request_id)
        if future is None:
            raise RuntimeError("dsh_request_future_missing")
        timeout = self.config.request_timeout_seconds
        if timeout is None:
            try:
                return await future
            finally:
                self._pending.pop(request_id, None)
        try:
            return await asyncio.wait_for(asyncio.shield(future), timeout=timeout)
        finally:
            self._pending.pop(request_id, None)

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        process = self._process
        if process is None:
            return
        try:
            await self.request("shutdown", None)
        except Exception:
            pass
        await self._terminate_process()

    async def _terminate_process(self) -> None:
        process = self._process
        if process is None:
            return
        if process.stdin is not None:
            process.stdin.close()
        try:
            await asyncio.wait_for(process.wait(), timeout=1.0)
        except (asyncio.TimeoutError, ProcessLookupError):
            try:
                process.kill()
            except ProcessLookupError:
                pass
            await process.wait()
        if self._reader_task is not None:
            self._reader_task.cancel()
            await asyncio.gather(self._reader_task, return_exceptions=True)
        if self._stderr_task is not None:
            self._stderr_task.cancel()
            await asyncio.gather(self._stderr_task, return_exceptions=True)
        self._process = None
        self._reader_task = None
        self._stderr_task = None
        for future in self._pending.values():
            if not future.done():
                future.set_exception(RuntimeError("dsh_harness_closed"))
        self._pending.clear()
        self._session_queues.clear()

    async def _write(self, message: Mapping[str, Any]) -> None:
        process = self._process
        if process is None or process.stdin is None:
            raise RuntimeError("dsh_harness_not_running")
        payload = json.dumps(dict(message), separators=(",", ":")) + "\n"
        async with self._write_lock:
            process.stdin.write(payload.encode("utf-8"))
            await process.stdin.drain()

    async def _reader_loop(self) -> None:
        process = self._process
        if process is None or process.stdout is None:
            return
        try:
            while True:
                raw = await process.stdout.readline()
                if not raw:
                    raise RuntimeError("dsh_harness_stdout_closed")
                try:
                    message = json.loads(raw.decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError):
                    continue
                if not isinstance(message, Mapping):
                    continue
                message_id = message.get("id")
                if message_id is not None and "method" not in message:
                    future = self._pending.get(str(message_id))
                    if future is None or future.done():
                        continue
                    if isinstance(message.get("error"), Mapping):
                        error = message["error"]
                        future.set_exception(
                            RuntimeError(str(error.get("message") or "dsh_jsonrpc_error"))
                        )
                    else:
                        future.set_result(message.get("result"))
                    continue
                method = str(message.get("method") or "")
                params = message.get("params")
                if method not in {"session.event", "session.status"} or not isinstance(params, Mapping):
                    continue
                session_id = str(params.get("sessionId") or "").strip()
                if not session_id:
                    continue
                queue = self._session_queues.setdefault(session_id, asyncio.Queue())
                await queue.put(dict(message))
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            for future in self._pending.values():
                if not future.done():
                    future.set_exception(exc)
            for session_id, queue in self._session_queues.items():
                await queue.put(
                    {
                        "method": "session.status",
                        "params": {
                            "sessionId": session_id,
                            "status": "idle",
                            "error": str(exc),
                        },
                    }
                )

    async def _drain_stderr(self) -> None:
        process = self._process
        if process is None or process.stderr is None:
            return
        while True:
            raw = await process.stderr.readline()
            if not raw:
                return


__all__ = ["DshHarnessClient", "DshHarnessConfig"]
