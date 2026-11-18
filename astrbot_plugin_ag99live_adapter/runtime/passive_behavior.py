from __future__ import annotations

import asyncio
import json
import time
from collections.abc import Awaitable, Callable
from typing import Any
from uuid import uuid4

from astrbot.api import logger

from ..motion.motion_intent import (
    MAX_IDLE_MOTION_STEPS,
    MOTION_INTENT_V4_SCHEMA_VERSION,
    normalize_motion_intent_v4_payload,
    resolve_selected_semantic_axis_profile,
)
from ..motion.payload_validation import validate_normalized_motion_intent_payload
from ..motion.provider_contract import (
    describe_provider_motion_record,
    normalize_provider_motion_record,
)
from ..prompts.passive_behavior import (
    PASSIVE_BEHAVIOR_RESPONSE_SCHEMA,
    PASSIVE_BEHAVIOR_SYSTEM_PROMPT,
    build_passive_behavior_prompt,
)
from ..protocol.parser import build_message_envelope
from .motion_emotion import read_motion_emotion
from .output_segment import PASSIVE_BEHAVIOR_MOTION_SOURCE


_POLL_INTERVAL_SECONDS = 0.1
_MAX_STREAM_CHARS = 16000
_MAX_ACTION_LINE_CHARS = 4096
_NONE_DECISION_LOG_INTERVAL_SECONDS = 30.0
_INVALID_OUTPUT_LOG_INTERVAL_SECONDS = 30.0


async def _discard_passive_output(_message: dict[str, Any]) -> bool:
    """Keep direct unit/test construction side-effect free without a sender."""

    return False


class PassiveBehaviorRuntime:
    """Run the OLV-only NeuroBrain action stream independently of chat Turns."""

    def __init__(
        self,
        *,
        runtime_state: Any,
        session_state: Any,
        turn_coordinator: Any,
        is_desktop_connected: Callable[[], bool],
        send_json: Callable[[dict[str, Any]], Awaitable[bool]] | None = None,
    ) -> None:
        self.runtime_state = runtime_state
        self.session_state = session_state
        self.turn_coordinator = turn_coordinator
        self.is_desktop_connected = is_desktop_connected
        self._send_json = send_json or _discard_passive_output
        self._task: asyncio.Task[None] | None = None
        self._active_stream_task: asyncio.Task[None] | None = None
        self._stopping = False
        self._last_request_at = 0.0
        self._last_decision_at = float("-inf")
        self._last_none_log_at = 0.0
        self._last_invalid_output_log_at = float("-inf")
        self._suppressed_invalid_outputs = 0
        self._provider_identity_key: tuple[str, int] | None = None
        self._unsupported_provider_identity: tuple[str, int] | None = None
        self._consecutive_provider_failures = 0
        self._retry_not_before = 0.0

    async def start(self) -> None:
        if self._task is not None and not self._task.done():
            return
        self._stopping = False
        self._task = asyncio.create_task(
            self._run(),
            name="ag99live-neurobrain-passive-actions",
        )

    async def stop(self) -> None:
        self._stopping = True
        task = self._task
        self._task = None
        if task is None or task.done():
            return
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)

    async def interrupt_active_request(self) -> None:
        task = self._active_stream_task
        if task is None or task.done():
            return
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)

    async def _run(self) -> None:
        while not self._stopping:
            try:
                await self._request_if_ready()
            except asyncio.CancelledError:
                current_task = asyncio.current_task()
                if (
                    self._stopping
                    or current_task is None
                    or current_task.cancelling() > 0
                ):
                    raise
                logger.debug("NeuroBrain passive behavior request interrupted")
            except Exception:
                logger.exception("NeuroBrain passive behavior stream failed")
            await asyncio.sleep(_POLL_INTERVAL_SECONDS)

    async def _request_if_ready(self) -> None:
        now = time.monotonic()
        if not bool(getattr(self.runtime_state, "passive_behavior_enabled", False)):
            return
        if not self._connected():
            return
        if bool(getattr(self.turn_coordinator, "has_active_speech_input", False)):
            return
        if getattr(self.session_state, "current_turn_id", None) is not None:
            return
        request_interval = max(
            int(getattr(self.runtime_state, "passive_behavior_request_interval_ms", 500)),
            250,
        ) / 1000
        cooldown = max(
            int(getattr(self.runtime_state, "passive_behavior_cooldown_ms", 3000)),
            0,
        ) / 1000
        if now - self._last_request_at < request_interval:
            return
        if now - self._last_decision_at < cooldown:
            return

        provider = getattr(
            self.runtime_state,
            "selected_passive_behavior_provider",
            None,
        )
        if provider is None:
            return
        provider_identity = self._get_provider_identity(provider)
        if provider_identity != self._provider_identity_key:
            self._provider_identity_key = provider_identity
            self._unsupported_provider_identity = None
            self._consecutive_provider_failures = 0
            self._retry_not_before = 0.0
            self._last_invalid_output_log_at = float("-inf")
            self._suppressed_invalid_outputs = 0
        if provider_identity == self._unsupported_provider_identity:
            return
        if now < self._retry_not_before:
            return
        self._last_request_at = now
        await self._run_stream_request(provider=provider, request_started_at=now)

    async def _run_stream_request(self, *, provider: Any, request_started_at: float) -> None:
        state = self._read_neurobrain_state()
        if state is None:
            logger.debug("NeuroBrain passive behavior skipped: state unavailable")
            return
        try:
            profile = resolve_selected_semantic_axis_profile(
                runtime_state=self.runtime_state,
            )
            window = getattr(self.turn_coordinator, "observation_window", None)
            prompt = build_passive_behavior_prompt(
                neurobrain_state=state,
                semantic_profile=profile,
                recent_interaction=window.recent_interaction() if window else None,
            )
        except Exception as exc:
            logger.debug("NeuroBrain passive behavior skipped: profile unavailable: %s", exc)
            return

        provider_id = str(
            getattr(self.runtime_state, "passive_behavior_provider_id", "") or ""
        ).strip()
        timeout_seconds = min(
            max(
                float(
                    getattr(
                        self.runtime_state,
                        "passive_behavior_timeout_seconds",
                        3.0,
                    )
                ),
                0.5,
            ),
            30.0,
        )
        result_ttl_seconds = min(
            max(
                int(
                    getattr(
                        self.runtime_state,
                        "passive_behavior_result_ttl_ms",
                        2500,
                    )
                ),
                250,
            ),
            30000,
        ) / 1000

        decision_accepted = False
        rejection: tuple[str, str] | None = None
        started = time.monotonic()

        def can_continue() -> bool:
            if self._stopping:
                return False
            if not bool(getattr(self.runtime_state, "passive_behavior_enabled", False)):
                return False
            if not self._connected():
                return False
            if bool(getattr(self.turn_coordinator, "has_active_speech_input", False)):
                return False
            if time.monotonic() - request_started_at > result_ttl_seconds:
                return False
            return getattr(self.session_state, "current_turn_id", None) is None

        def reject(reason: str, detail: str = "") -> bool:
            nonlocal rejection
            if rejection is None:
                rejection = (reason, detail[:400])
            return True

        async def process_line(raw_line: str) -> bool:
            nonlocal decision_accepted
            line = raw_line.strip()
            if not line:
                return True
            if len(line) > _MAX_ACTION_LINE_CHARS:
                return reject("line_too_large", f"length={len(line)}")
            try:
                action = json.loads(line)
            except json.JSONDecodeError as exc:
                return reject("invalid_json", f"{exc.msg} at {exc.pos}")
            if not isinstance(action, dict):
                return reject("not_object", describe_provider_motion_record(action))

            decision = action.get("decision")
            if decision == "none" and set(action) == {"decision"}:
                decision_accepted = True
                now = time.monotonic()
                self._last_decision_at = now
                if (
                    self._last_none_log_at == 0.0
                    or now - self._last_none_log_at
                    >= _NONE_DECISION_LOG_INTERVAL_SECONDS
                ):
                    self._last_none_log_at = now
                    logger.debug("NeuroBrain passive behavior decision=none")
                return False
            try:
                action = normalize_provider_motion_record(
                    action,
                    default_intent_tag="动作",
                    infer_emit_decision=True,
                )
            except ValueError as exc:
                return reject(
                    "record_invalid", f"{exc} shape={describe_provider_motion_record(action)}"
                )
            decision = action.get("decision")
            if decision != "emit":
                return reject("decision_invalid", describe_provider_motion_record(action))
            allowed_fields = {
                "decision",
                "intent_tags",
                "motion_steps",
                "duration_hint_ms",
            }
            unknown_fields = sorted(set(action) - allowed_fields)
            if unknown_fields:
                return reject("unknown_fields", ",".join(unknown_fields))
            try:
                motion_payload = _normalize_motion_action(action, profile, self.runtime_state)
            except (TypeError, ValueError) as exc:
                return reject(
                    "motion_invalid", f"{exc} shape={describe_provider_motion_record(action)}"
                )
            if not can_continue():
                return False

            decision_accepted = True
            message_id = f"idle_action:{uuid4().hex}"
            sent = await self._send_json(build_message_envelope(
                "output.idle_motion",
                source="adapter",
                turn_id=None,
                message_id=message_id,
                payload={
                    "motion": motion_payload,
                    "expires_at_epoch_ms": int((time.time() + max(
                        0.0, result_ttl_seconds - (time.monotonic() - request_started_at)
                    )) * 1000),
                },
            ))
            if not sent:
                return False
            self._last_decision_at = time.monotonic()
            logger.info(
                "WIRING passive_behavior.action_streamed message_id=%s "
                "tags=%s axes=%s latency_ms=%s",
                message_id,
                ",".join(motion_payload.get("intent_tags") or []),
                ",".join(
                    sorted(
                        {
                            axis_id
                            for step in motion_payload.get("motion_steps", [])
                            for axis_id in (step.get("axis_values") or {})
                        }
                    )
                ),
                int((time.monotonic() - started) * 1000),
            )
            return False

        async def run_stream() -> None:
            await _consume_provider_stream(
                provider=provider,
                prompt=prompt,
                system_prompt=PASSIVE_BEHAVIOR_SYSTEM_PROMPT,
                on_line=process_line,
                on_rejection=reject,
                should_continue=can_continue,
            )

        expires_at = request_started_at + result_ttl_seconds
        remaining_seconds = min(timeout_seconds, expires_at - time.monotonic())
        if remaining_seconds <= 0 or not can_continue():
            return

        stream_task = asyncio.create_task(
            asyncio.wait_for(run_stream(), timeout=remaining_seconds),
            name="ag99live-neurobrain-passive-provider-stream",
        )
        self._active_stream_task = stream_task
        provider_identity = self._get_provider_identity(provider)
        try:
            await stream_task
            if decision_accepted:
                self._consecutive_provider_failures = 0
                self._retry_not_before = 0.0
                if self._suppressed_invalid_outputs:
                    logger.info(
                        "NeuroBrain passive behavior recovered: provider=%s suppressed_failures=%s",
                        provider_id or "<unknown>",
                        self._suppressed_invalid_outputs,
                    )
                self._last_invalid_output_log_at = float("-inf")
                self._suppressed_invalid_outputs = 0
            elif can_continue():
                self._schedule_retry()
                reason, detail = rejection or ("no_valid_decision", "")
                self._log_invalid_output(provider_id, reason, detail)
        except asyncio.CancelledError:
            raise
        except asyncio.TimeoutError:
            self._schedule_retry()
            if time.monotonic() >= expires_at:
                logger.debug(
                    "NeuroBrain passive behavior stream expired: provider=%s",
                    provider_id or "<unknown>",
                )
            else:
                logger.warning(
                    "NeuroBrain passive behavior stream timed out: provider=%s timeout_seconds=%s",
                    provider_id or "<unknown>",
                    timeout_seconds,
                )
        except NotImplementedError:
            self._unsupported_provider_identity = provider_identity
            logger.error(
                "NeuroBrain passive behavior provider does not implement text_chat_stream: provider=%s",
                provider_id or "<unknown>",
            )
        except Exception:
            self._schedule_retry()
            logger.exception(
                "NeuroBrain passive behavior provider stream failed: provider=%s",
                provider_id or "<unknown>",
            )
        finally:
            if self._active_stream_task is stream_task:
                self._active_stream_task = None

    def _schedule_retry(self) -> None:
        self._consecutive_provider_failures += 1
        delay = min(60.0, 0.5 * (2 ** min(self._consecutive_provider_failures - 1, 7)))
        self._retry_not_before = time.monotonic() + delay

    def _log_invalid_output(self, provider_id: str, reason: str, detail: str) -> None:
        now = time.monotonic()
        if now - self._last_invalid_output_log_at < _INVALID_OUTPUT_LOG_INTERVAL_SECONDS:
            self._suppressed_invalid_outputs += 1
            return
        logger.warning(
            "NeuroBrain passive behavior output rejected: provider=%s reason=%s detail=%r "
            "consecutive_failures=%s retry_backoff_s=%.1f suppressed_failures=%s",
            provider_id or "<unknown>",
            reason,
            detail,
            self._consecutive_provider_failures,
            max(0.0, self._retry_not_before - now),
            self._suppressed_invalid_outputs,
        )
        self._last_invalid_output_log_at = now
        self._suppressed_invalid_outputs = 0

    def _get_provider_identity(self, provider: Any) -> tuple[str, int]:
        provider_id = str(
            getattr(self.runtime_state, "passive_behavior_provider_id", "") or ""
        ).strip()
        return provider_id, id(provider)

    def _read_neurobrain_state(self) -> dict[str, Any] | None:
        return read_motion_emotion(self.runtime_state)

    def _connected(self) -> bool:
        try:
            return bool(self.is_desktop_connected())
        except Exception:
            return False


def _normalize_motion_action(
    action: dict[str, Any],
    semantic_profile: dict[str, Any],
    runtime_state: Any,
) -> dict[str, Any]:
    contract_payload: dict[str, Any] = {
        "schema_version": MOTION_INTENT_V4_SCHEMA_VERSION,
        "profile_id": semantic_profile.get("profile_id"),
        "profile_revision": semantic_profile.get("revision"),
        "model_id": semantic_profile.get("model_id"),
        "mode": "expressive",
        "intent_tags": action.get("intent_tags") or ["动作"],
        "motion_steps": action.get("motion_steps"),
    }
    contract_payload["duration_hint_ms"] = action.get("duration_hint_ms", 4000)
    normalized = normalize_motion_intent_v4_payload(contract_payload)
    if len(normalized.get("motion_steps") or []) > MAX_IDLE_MOTION_STEPS:
        raise ValueError("motion_steps_count_invalid_for_idle")
    normalized["duration_hint_ms"] = max(3000, normalized["duration_hint_ms"])
    if not any(
        value != 0
        for step in normalized.get("motion_steps", [])
        for value in (step.get("axis_values") or {}).values()
    ):
        raise ValueError("motion_has_no_non_neutral_axis")
    validated, reason = validate_normalized_motion_intent_payload(
        normalized,
        runtime_state,
        base_reason=PASSIVE_BEHAVIOR_MOTION_SOURCE,
        semantic_profile=semantic_profile,
    )
    if validated is None:
        raise ValueError(reason or "motion_profile_validation_failed")
    return validated


async def _consume_provider_stream(
    *,
    provider: Any,
    prompt: str,
    system_prompt: str,
    on_line: Callable[[str], Awaitable[bool]],
    on_rejection: Callable[[str, str], bool],
    should_continue: Callable[[], bool],
) -> None:
    options = {}
    provider_config = getattr(provider, "provider_config", {})
    if isinstance(provider_config, dict) and provider_config.get("type") == "ollama_chat_completion":
        # AstrBot forwards extra_body through text_chat_stream and translates
        # response_format into Ollama's native format for this request.
        options["extra_body"] = {
            "response_format": {
                "type": "json_schema",
                "json_schema": {"schema": PASSIVE_BEHAVIOR_RESPONSE_SCHEMA},
            },
        }
    stream = provider.text_chat_stream(
        prompt=prompt,
        system_prompt=system_prompt,
        **options,
    )
    pending = ""
    decoder = json.JSONDecoder()
    streamed_text = ""
    saw_text_chunk = False

    async def accept_text(value: str) -> bool:
        nonlocal pending, streamed_text
        if not value:
            return True
        if len(streamed_text) + len(value) > _MAX_STREAM_CHARS:
            on_rejection("output_too_large", "")
            return False
        streamed_text += value
        pending += value
        # Whitespace within an object is legal JSON. Decode a complete value
        # instead of treating each model-generated newline as a record boundary.
        pending = pending.lstrip()
        while pending:
            try:
                _, end = decoder.raw_decode(pending)
            except json.JSONDecodeError:
                if len(pending) > _MAX_ACTION_LINE_CHARS:
                    await on_line(pending)
                    return False
                break
            record, pending = pending[:end], pending[end:].lstrip()
            if not await on_line(record):
                return False
        return True

    try:
        async for response in stream:
            if not should_continue():
                return
            role = str(getattr(response, "role", "") or "")
            chunk_text = str(getattr(response, "completion_text", "") or "")
            if role == "err":
                raise RuntimeError(chunk_text or "provider_stream_error")
            if bool(getattr(response, "is_chunk", False)):
                if chunk_text:
                    saw_text_chunk = True
                    if not await accept_text(chunk_text):
                        return
                continue
            if not chunk_text:
                continue
            if not saw_text_chunk:
                on_rejection("no_streamed_text", "")
                return
            if chunk_text.startswith(streamed_text):
                if not await accept_text(chunk_text[len(streamed_text) :]):
                    return
            elif streamed_text.startswith(chunk_text) or chunk_text == streamed_text:
                continue
            else:
                logger.debug(
                    "NeuroBrain passive stream final response differed from streamed chunks; "
                    "keeping incrementally received output"
                )
        if pending.strip() and should_continue():
            await on_line(pending)
    finally:
        close = getattr(stream, "aclose", None)
        if callable(close):
            await close()
