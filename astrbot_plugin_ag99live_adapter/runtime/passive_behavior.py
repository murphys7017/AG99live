from __future__ import annotations

import asyncio
import json
import math
import time
from collections.abc import Awaitable, Callable, Mapping
from typing import Any
from uuid import uuid4

from astrbot.api import logger

from ..motion.motion_intent import (
    MOTION_INTENT_V4_SCHEMA_VERSION,
    normalize_motion_intent_v4_payload,
    resolve_selected_semantic_axis_profile,
)
from ..motion.payload_validation import validate_normalized_motion_intent_payload
from ..prompts.passive_behavior import (
    PASSIVE_BEHAVIOR_SYSTEM_PROMPT,
    build_passive_behavior_prompt,
)
from .output_segment import PASSIVE_BEHAVIOR_MOTION_SOURCE


_POLL_INTERVAL_SECONDS = 0.1
_MAX_ACTIONS_PER_STREAM = 3
_MAX_STREAM_CHARS = 16000
_MAX_ACTION_LINE_CHARS = 4096
_EMOTION_KEYS = (
    "joy",
    "trust",
    "fear",
    "surprise",
    "sadness",
    "disgust",
    "anger",
    "anticipation",
)
_BEHAVIOR_KEYS = (
    "engagement",
    "avoidance",
    "expression",
    "exploration",
    "initiative",
    "activation",
)
_TENDENCY_KEYS = (
    "Joy",
    "Trust",
    "Fear",
    "Surprise",
    "Sadness",
    "Disgust",
    "Anger",
    "Anticipation",
)


class PassiveBehaviorRuntime:
    """Run the OLV-only NeuroBrain action stream independently of chat Turns."""

    def __init__(
        self,
        *,
        runtime_state: Any,
        session_state: Any,
        turn_coordinator: Any,
        is_desktop_connected: Callable[[], bool],
    ) -> None:
        self.runtime_state = runtime_state
        self.session_state = session_state
        self.turn_coordinator = turn_coordinator
        self.is_desktop_connected = is_desktop_connected
        self._task: asyncio.Task[None] | None = None
        self._active_stream_task: asyncio.Task[None] | None = None
        self._stopping = False
        self._last_request_at = 0.0
        self._last_action_at = 0.0
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
        if now - self._last_action_at < cooldown:
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
            prompt = build_passive_behavior_prompt(
                neurobrain_state=state,
                semantic_profile=profile,
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

        turn_id: str | None = None
        sequence = 0
        emitted_count = 0
        output_failed = False
        cancelled = False
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
            current_turn_id = getattr(self.session_state, "current_turn_id", None)
            return current_turn_id is None if turn_id is None else current_turn_id == turn_id

        async def process_line(raw_line: str) -> bool:
            nonlocal turn_id, sequence, emitted_count, output_failed
            line = raw_line.strip()
            if not line:
                return True
            if len(line) > _MAX_ACTION_LINE_CHARS:
                logger.warning(
                    "NeuroBrain passive action line rejected: reason=line_too_large length=%s",
                    len(line),
                )
                return True
            try:
                action = json.loads(line)
            except json.JSONDecodeError:
                logger.warning(
                    "NeuroBrain passive action line rejected: reason=invalid_json line=%s",
                    line[:240],
                )
                return True
            if not isinstance(action, dict):
                logger.warning("NeuroBrain passive action line rejected: reason=not_object")
                return True

            decision = action.get("decision")
            if decision == "none" and set(action) == {"decision"}:
                logger.debug("NeuroBrain passive behavior decision=none")
                return True
            if decision != "emit":
                logger.warning(
                    "NeuroBrain passive action line rejected: reason=decision_invalid"
                )
                return True
            allowed_fields = {
                "decision",
                "intent_tags",
                "axis_levels",
                "duration_hint_ms",
            }
            unknown_fields = sorted(set(action) - allowed_fields)
            if unknown_fields:
                logger.warning(
                    "NeuroBrain passive action line rejected: reason=unknown_fields fields=%s",
                    ",".join(unknown_fields),
                )
                return True
            try:
                motion_payload = _normalize_motion_action(action, profile, self.runtime_state)
            except (TypeError, ValueError) as exc:
                logger.warning(
                    "NeuroBrain passive action line rejected: reason=motion_invalid error=%s",
                    exc,
                )
                return True
            if not can_continue():
                return False

            if turn_id is None:
                turn_id = await self.turn_coordinator.begin_passive_output_turn()
                if turn_id is None:
                    return False
            if not can_continue():
                return False

            message_id = f"passive_action:{uuid4().hex}"
            try:
                await self.turn_coordinator.emit_passive_motion_segment(
                    turn_id=turn_id,
                    message_id=message_id,
                    sequence=sequence,
                    motion_payload=motion_payload,
                )
            except Exception:
                output_failed = True
                raise
            sequence += 1
            emitted_count += 1
            self._last_action_at = time.monotonic()
            logger.info(
                "WIRING passive_behavior.action_streamed turn_id=%s sequence=%s "
                "tags=%s axes=%s latency_ms=%s",
                turn_id,
                sequence - 1,
                ",".join(motion_payload.get("intent_tags") or []),
                ",".join(motion_payload.get("axis_levels", {}).keys()),
                int((time.monotonic() - started) * 1000),
            )
            return emitted_count < _MAX_ACTIONS_PER_STREAM

        async def run_stream() -> None:
            await _consume_provider_stream(
                provider=provider,
                prompt=prompt,
                system_prompt=PASSIVE_BEHAVIOR_SYSTEM_PROMPT,
                on_line=process_line,
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
            self._consecutive_provider_failures = 0
            self._retry_not_before = 0.0
        except asyncio.CancelledError:
            cancelled = True
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
            if turn_id and self.session_state.current_turn_id == turn_id:
                try:
                    if output_failed or cancelled or not emitted_count:
                        await self.turn_coordinator.fail_proactive_output_turn(
                            turn_id=turn_id,
                            reason="passive_behavior_output_failed"
                            if output_failed
                            else "passive_behavior_stream_cancelled"
                            if cancelled
                            else "passive_behavior_no_output",
                        )
                    else:
                        await self.turn_coordinator.close_turn_output_queue(
                            turn_id=turn_id,
                        )
                except Exception:
                    logger.debug(
                        "NeuroBrain passive output cleanup skipped: turn_id=%s",
                        turn_id,
                        exc_info=True,
                    )

    def _schedule_retry(self) -> None:
        self._consecutive_provider_failures += 1
        delay = min(60.0, 0.5 * (2 ** min(self._consecutive_provider_failures - 1, 7)))
        self._retry_not_before = time.monotonic() + delay

    def _get_provider_identity(self, provider: Any) -> tuple[str, int]:
        provider_id = str(
            getattr(self.runtime_state, "passive_behavior_provider_id", "") or ""
        ).strip()
        return provider_id, id(provider)

    def _read_neurobrain_state(self) -> dict[str, Any] | None:
        context = getattr(self.runtime_state, "plugin_context", None)
        get_registered_star = getattr(context, "get_registered_star", None)
        if not callable(get_registered_star):
            return None
        try:
            metadata = get_registered_star("astrbot_plugin_neurobrain")
            plugin = getattr(metadata, "star_cls", None)
            if plugin is None or not bool(getattr(plugin, "enabled", True)):
                return None
            readonly_api = getattr(plugin, "readonly_api", None)
            get_state = getattr(readonly_api, "get_state", None)
            if not callable(get_state):
                return None
            snapshot = get_state()
        except Exception as exc:
            logger.debug("NeuroBrain passive state read failed: %s", exc)
            return None
        return _project_neurobrain_state(snapshot)

    def _connected(self) -> bool:
        try:
            return bool(self.is_desktop_connected())
        except Exception:
            return False


def _project_neurobrain_state(snapshot: Any) -> dict[str, Any] | None:
    if not isinstance(snapshot, Mapping):
        return None

    def unit_values(value: Any, keys: tuple[str, ...]) -> dict[str, float]:
        if not isinstance(value, Mapping):
            return {}
        result: dict[str, float] = {}
        for key in keys:
            raw = value.get(key)
            if isinstance(raw, bool) or not isinstance(raw, (int, float)):
                continue
            number = float(raw)
            if math.isfinite(number):
                result[key] = max(0.0, min(1.0, number))
        return result

    def tendency_values(value: Any) -> dict[str, int]:
        if not isinstance(value, Mapping):
            return {}
        result: dict[str, int] = {}
        for key in _TENDENCY_KEYS:
            raw = value.get(key)
            if isinstance(raw, bool) or not isinstance(raw, int):
                continue
            result[key] = max(0, min(10, raw))
        return result

    emotion = unit_values(snapshot.get("emotion"), _EMOTION_KEYS)
    behavior = unit_values(snapshot.get("behavior"), _BEHAVIOR_KEYS)
    tendency = tendency_values(snapshot.get("last_tendency"))
    if not emotion and not behavior and not tendency:
        return None
    raw_step = snapshot.get("step")
    step = raw_step if isinstance(raw_step, int) and not isinstance(raw_step, bool) else 0
    return {
        "step": max(0, step),
        "emotion": emotion,
        "behavior": behavior,
        "last_tendency": tendency,
    }


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
        "intent_tags": action.get("intent_tags"),
        "axis_levels": action.get("axis_levels"),
    }
    if "duration_hint_ms" in action:
        contract_payload["duration_hint_ms"] = action["duration_hint_ms"]
    normalized = normalize_motion_intent_v4_payload(contract_payload)
    if not any(level != 0 for level in normalized.get("axis_levels", {}).values()):
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
    should_continue: Callable[[], bool],
) -> None:
    stream = provider.text_chat_stream(
        prompt=prompt,
        system_prompt=system_prompt,
    )
    pending = ""
    streamed_text = ""
    saw_text_chunk = False

    async def accept_text(value: str) -> bool:
        nonlocal pending, streamed_text
        if not value:
            return True
        if len(streamed_text) + len(value) > _MAX_STREAM_CHARS:
            logger.warning("NeuroBrain passive behavior stream stopped: reason=output_too_large")
            return False
        streamed_text += value
        pending += value
        lines = pending.split("\n")
        pending = lines.pop()
        for line in lines:
            if not await on_line(line):
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
                logger.warning(
                    "NeuroBrain passive behavior skipped: provider returned a final "
                    "response without streamed text chunks"
                )
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
