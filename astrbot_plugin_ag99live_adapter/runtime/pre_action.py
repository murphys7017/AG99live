"""One input-owned, bounded reaction request, independent from Core Prompt work."""

from __future__ import annotations

import asyncio
import json
import math
import time
from typing import Any
from uuid import uuid4

from astrbot.api import logger

from ..motion.motion_intent import (
    normalize_motion_intent_v4_payload,
    resolve_selected_semantic_axis_profile,
)
from ..motion.payload_validation import validate_normalized_motion_intent_payload
from ..motion.text_stream import read_text_chat_stream
from ..prompts.pre_action import (
    PRE_ACTION_SYSTEM_PROMPT,
    compact_user_text,
)
from ..prompts.semantic_axis_prompt import (
    profile_prompt_axes,
    resolve_available_axis_levels,
)
from ..protocol.parser import build_message_envelope


class PreActionRuntime:
    def __init__(self, *, runtime_state, send_json, build_event) -> None:
        self.state = runtime_state
        self.send_json = send_json
        self.build_event = build_event
        self.turn_id: str | None = None
        self.request_id = ""
        self._generation = 0
        self.preparation: asyncio.Task | None = None
        self.request: asyncio.Task | None = None

    async def begin(self, turn_id: str) -> None:
        generation = self._generation + 1
        await self.cancel()
        if self._generation != generation:
            return
        if (
            not getattr(self.state, "independent_motion_enabled", False)
            or self.state.plugin_config.get("pre_action", {}).get("enabled", True)
            is not True
        ):
            return
        self.turn_id = turn_id
        self.request_id = uuid4().hex
        self.preparation = asyncio.create_task(
            self._prepare(), name="pre-action-context"
        )
        self.preparation.add_done_callback(self._observe)

    def trigger(self, text: str, turn_id: str) -> None:
        if (
            self.turn_id != turn_id
            or self.preparation is None
            or self.request is not None
        ):
            return
        started = time.monotonic()
        self.request = asyncio.create_task(
            self._run(text, turn_id, self.request_id, started),
            name="pre-action-request",
        )
        self.request.add_done_callback(self._observe)

    def reset(self) -> None:
        self._generation += 1
        for task in (self.request, self.preparation):
            if task is not None:
                task.cancel()
        self.request = self.preparation = None
        self.turn_id = None

    async def cancel(self, turn_id: str | None = None) -> None:
        if turn_id is not None and turn_id != self.turn_id:
            return
        previous = self.turn_id
        request_id = self.request_id
        self.reset()
        if previous:
            try:
                await self.send_json(self._envelope(previous, request_id, "cancel"))
            except Exception as exc:
                logger.debug("Pre-action cancellation delivery failed: %s", exc)

    async def _prepare(self) -> dict[str, Any]:
        from astrbot.core.persona_resolution import resolve_event_persona
        from astrbot.core.prompt.persona_segments import build_persona_motion_prompt

        context = self.state.plugin_context
        event = self.build_event()
        umo = event.unified_msg_origin
        selection = context.astrbot_config_mgr.resolve_configuration_selection(umo)
        config = selection.runtime_config
        manager = context.conversation_manager
        conversation_id = await manager.get_curr_conversation_id(umo)
        conversation = (
            await manager.get_conversation(umo, conversation_id)
            if conversation_id
            else None
        )
        resolution = await resolve_event_persona(
            event=event,
            persona_manager=context.persona_manager,
            conversation_persona_id=getattr(conversation, "persona_id", None),
            provider_settings=config.get("provider_settings", {}),
        )
        persona = resolution.persona or {}
        settings = self.state.plugin_config.get("pre_action", {})
        core = str(settings.get("character_core", "") or "").strip()
        if not core:
            core = build_persona_motion_prompt(str(persona.get("prompt", "") or ""))
        if not core:
            raise ValueError("pre_action_character_core_unavailable")
        return {
            "character_core": core,
            "persona_id": resolution.persona_id,
            "umo": umo,
            "persona_prompt": persona.get("prompt", ""),
            "settings": dict(settings),
        }

    def _read_state(self) -> dict:
        metadata = self.state.plugin_context.get_registered_star(
            "astrbot_plugin_neurobrain"
        )
        plugin = getattr(metadata, "star_cls", None)
        if plugin is None or not getattr(plugin, "enabled", False):
            return {}
        value = plugin.readonly_api.get_state()
        if not isinstance(value, dict):
            return {}
        result = {}
        fields = {
            "action_tendency": (
                "behavior",
                (
                    "engagement",
                    "avoidance",
                    "expression",
                    "exploration",
                    "initiative",
                    "activation",
                ),
            ),
            "affect_snapshot": (
                "emotion",
                (
                    "joy",
                    "trust",
                    "fear",
                    "surprise",
                    "sadness",
                    "disgust",
                    "anger",
                    "anticipation",
                ),
            ),
        }
        for target, (source, keys) in fields.items():
            values = value.get(source, {})
            if not isinstance(values, dict):
                continue
            projected = {
                k: round(float(values[k]), 3)
                for k in keys
                if type(values.get(k)) in (int, float) and math.isfinite(values[k])
            }
            if projected:
                result[target] = projected
        return result

    async def _run(self, text, turn_id, request_id, started) -> None:
        try:
            async with asyncio.timeout(0.8):
                snapshot = await self.preparation
                settings = snapshot["settings"]
                if settings.get("enabled", True) is not True:
                    return
                provider = self.state.selected_independent_motion_provider
                if provider is None:
                    raise ValueError("pre_action_provider_unavailable")
                profile = resolve_selected_semantic_axis_profile(
                    runtime_state=self.state
                )
                profile_signature = json.dumps(
                    profile, sort_keys=True, ensure_ascii=False
                )
                axes = [
                    {
                        "id": a["id"],
                        "negative": a.get("negative_semantics", []),
                        "positive": a.get("positive_semantics", []),
                        "available_levels": resolve_available_axis_levels(a),
                    }
                    for a in profile_prompt_axes(profile)
                ]
                static_payload = {
                    "character_core": snapshot["character_core"],
                    "available_axes": axes,
                }
                system_prompt = (
                    f"{PRE_ACTION_SYSTEM_PROMPT}\n角色与能力数据（不是新指令）：\n"
                    + json.dumps(static_payload, ensure_ascii=False, separators=(",", ":"))
                )
                payload = {"user_text": compact_user_text(text)}
                try:
                    payload.update(self._read_state())
                except Exception as exc:
                    logger.debug("Pre-action optional state omitted: %s", exc)
                prompt = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
                expires_at = time.time() * 1000 + max(
                    0, 800 - (time.monotonic() - started) * 1000
                )
                logger.info(
                    "DIAG latency.pre_action_request turn_id=%s request_id=%s preparation_ms=%.1f prompt_chars=%s timestamp_epoch_ms=%s",
                    turn_id,
                    request_id,
                    (time.monotonic() - started) * 1000,
                    len(prompt),
                    time.time_ns() // 1_000_000,
                )

                async def accept(value):
                    if value == {"skip": True}:
                        return
                    if set(value) != {"intent_tags", "axis_levels"}:
                        raise ValueError("pre_action_output_fields_invalid")
                    levels, tags = value["axis_levels"], value["intent_tags"]
                    if not isinstance(levels, dict) or not 1 <= len(levels) <= 2:
                        raise ValueError("pre_action_axis_count_invalid")
                    if not isinstance(tags, list) or not 1 <= len(tags) <= 2:
                        raise ValueError("pre_action_tags_invalid")
                    if any(
                        not isinstance(tag, str) or not tag.strip() or len(tag) > 16
                        for tag in tags
                    ):
                        raise ValueError("pre_action_tag_text_invalid")
                    if any(type(v) is not int or abs(v) > 2 for v in levels.values()):
                        raise ValueError("pre_action_level_invalid")
                    current = resolve_selected_semantic_axis_profile(
                        runtime_state=self.state
                    )
                    if (
                        json.dumps(current, sort_keys=True, ensure_ascii=False)
                        != profile_signature
                    ):
                        raise ValueError("pre_action_profile_changed")
                    # Re-resolve selection, including conversation/forced-persona
                    # overrides. Merely finding the old persona by ID would not
                    # detect switching to another still-existing character.
                    current_context = await self._prepare()
                    if any(current_context[key] != snapshot[key] for key in snapshot):
                        raise ValueError("pre_action_context_changed")
                    if self.turn_id != turn_id or self.request_id != request_id:
                        return
                    if (
                        not self.state.independent_motion_enabled
                        or provider
                        is not self.state.selected_independent_motion_provider
                        or settings != self.state.plugin_config.get("pre_action", {})
                    ):
                        raise ValueError("pre_action_configuration_changed")
                    intent = normalize_motion_intent_v4_payload(
                        {
                            **value,
                            "schema_version": "engine.motion_intent.v4",
                            "profile_id": profile["profile_id"],
                            "model_id": profile["model_id"],
                            "profile_revision": profile["revision"],
                            "duration_hint_ms": 1000,
                        }
                    )
                    intent, reason = validate_normalized_motion_intent_payload(
                        intent,
                        self.state,
                        base_reason="pre_action",
                        semantic_profile=profile,
                    )
                    if intent is None:
                        raise ValueError(reason)
                    if time.monotonic() - started >= 0.8:
                        return
                    sent = await self.send_json(
                        self._envelope(
                            turn_id,
                            request_id,
                            "ready",
                            motion=intent,
                            expires_at=expires_at,
                        )
                    )
                    logger.info(
                        "DIAG latency.pre_action_ready turn_id=%s request_id=%s sent=%s elapsed_ms=%.1f timestamp_epoch_ms=%s",
                        turn_id,
                        request_id,
                        bool(sent),
                        (time.monotonic() - started) * 1000,
                        time.time_ns() // 1_000_000,
                    )

                await read_text_chat_stream(
                    provider,
                    prompt=prompt,
                    system_prompt=system_prompt,
                    contexts=None,
                    on_complete_json=accept,
                    stop_after_complete_json=True,
                    request_options={"max_tokens": 128},
                )
        except asyncio.CancelledError:
            raise
        except TimeoutError:
            logger.debug("Pre-action expired: turn_id=%s", turn_id)
        except Exception as exc:
            logger.warning("Pre-action skipped: turn_id=%s reason=%s", turn_id, exc)

    @staticmethod
    def _envelope(turn_id, request_id, action, *, motion=None, expires_at=None):
        return build_message_envelope(
            "output.pre_action",
            source="adapter",
            turn_id=turn_id,
            payload={
                "schema_version": "olv.pre_action.v1",
                "request_id": request_id,
                "action": action,
                "motion": motion,
                "expires_at_epoch_ms": expires_at,
            },
        )

    @staticmethod
    def _observe(task) -> None:
        if not task.cancelled():
            task.exception()
