from __future__ import annotations

import asyncio
from collections.abc import Mapping
from dataclasses import dataclass, replace
import json
from typing import Any

from astrbot.api import logger

from ...motion.output_sanitizer import sanitize_assistant_output_text
from ...motion.payload_validation import (
    normalize_motion_arguments_payload,
)
from .prompt_builder import (
    _build_motion_capability_prompt_payload,
    _build_motion_runtime_payload,
    _build_motion_static_capability_payload,
)
from .prompt_context import _record_motion_prompt_reference_observation
from .shared import (
    _MotionRuntimeBundle,
    _append_resolution_reason,
    _resolve_frontend_identity_snapshot,
    _sanitize_reason_fragment,
)

INDEPENDENT_MOTION_TASK_EXTRA_KEY = "_ag99live_independent_motion_task"
INDEPENDENT_MOTION_RESULT_EXTRA_KEY = "_ag99live_independent_motion_result"
PERSONA_EXPRESSION_INTENT_METADATA_KEY = "interaction.persona_expression_intent"
_MAX_RETAINED_RESULT_TURNS = 64
# Independent motion is supplementary output; it must not hold the main reply
# indefinitely when the secondary provider is slow.
_PARALLEL_MOTION_WAIT_SECONDS = 2.0


def _consume_background_motion_exception(task: asyncio.Task) -> None:
    if task.cancelled():
        return
    error = task.exception()
    if error is not None:
        logger.warning(
            "WIRING independent_motion.background_task_failed error=%s",
            error,
        )


@dataclass(slots=True)
class IndependentMotionResult:
    assistant_text: str
    motion_payload: dict[str, Any] | None
    reason: str
    image_count: int


def is_persona_expression_request(request: Any) -> bool:
    """Identify an AstrBot request that belongs to the Persona expression path."""
    metadata = getattr(request, "metadata", None)
    if not isinstance(metadata, Mapping):
        return False
    intent = metadata.get(PERSONA_EXPRESSION_INTENT_METADATA_KEY)
    return isinstance(intent, Mapping) and bool(str(intent.get("phase") or "").strip())


def store_motion_result_for_turn(
    runtime_state: Any,
    *,
    turn_id: str,
    result: IndependentMotionResult,
    assistant_text: str,
) -> bool:
    normalized_turn_id = str(turn_id or "").strip()
    normalized_text = sanitize_assistant_output_text(str(assistant_text or ""))
    if not normalized_turn_id:
        logger.warning(
            "WIRING independent_motion.cache_store_rejected reason=turn_id_missing "
            "assistant_text_len=%s",
            len(normalized_text),
        )
        return False

    cache = getattr(runtime_state, "independent_motion_result_cache", None)
    if not isinstance(cache, dict):
        cache = {}
        runtime_state.independent_motion_result_cache = cache
    entries = cache.setdefault(normalized_turn_id, [])
    if not isinstance(entries, list):
        entries = []
        cache[normalized_turn_id] = entries
    entries.append(replace(result, assistant_text=normalized_text))
    if len(entries) > 8:
        del entries[:-8]
    while len(cache) > _MAX_RETAINED_RESULT_TURNS:
        cache.pop(next(iter(cache)))
    logger.info(
        "WIRING independent_motion.cache_stored turn_id=%s entry_count=%s "
        "assistant_text_len=%s payload_present=%s reason=%s",
        normalized_turn_id,
        len(entries),
        len(normalized_text),
        result.motion_payload is not None,
        result.reason,
    )
    return True


def take_motion_result_for_turn(
    runtime_state: Any,
    *,
    turn_id: str,
    assistant_text: str,
) -> IndependentMotionResult | None:
    normalized_turn_id = str(turn_id or "").strip()
    normalized_text = sanitize_assistant_output_text(str(assistant_text or ""))
    cache = getattr(runtime_state, "independent_motion_result_cache", None)
    if not normalized_turn_id or not isinstance(cache, dict):
        logger.warning(
            "WIRING independent_motion.cache_consume_miss turn_id=%s "
            "reason=%s requested_text_len=%s",
            normalized_turn_id or "<missing>",
            "turn_id_missing" if not normalized_turn_id else "cache_unavailable",
            len(normalized_text),
        )
        return None
    entries = cache.get(normalized_turn_id)
    if not isinstance(entries, list) or not entries:
        logger.warning(
            "WIRING independent_motion.cache_consume_miss turn_id=%s "
            "reason=entry_missing requested_text_len=%s",
            normalized_turn_id,
            len(normalized_text),
        )
        return None

    entries_before = len(entries)
    selected_index: int | None = None
    match_mode = "turn_fallback"
    if normalized_text:
        for index in range(len(entries) - 1, -1, -1):
            result = entries[index]
            if (
                isinstance(result, IndependentMotionResult)
                and result.assistant_text == normalized_text
            ):
                selected_index = index
                match_mode = "assistant_text_exact"
                break
    if selected_index is None:
        for index in range(len(entries) - 1, -1, -1):
            if isinstance(entries[index], IndependentMotionResult):
                selected_index = index
                break
    if selected_index is None:
        logger.warning(
            "WIRING independent_motion.cache_consume_miss turn_id=%s "
            "reason=entry_invalid entries=%s requested_text_len=%s",
            normalized_turn_id,
            entries_before,
            len(normalized_text),
        )
        return None

    selected = entries.pop(selected_index)
    if not entries:
        cache.pop(normalized_turn_id, None)
    logger.info(
        "WIRING independent_motion.cache_consumed turn_id=%s mode=%s "
        "entries_before=%s entries_after=%s requested_text_len=%s "
        "stored_text_len=%s payload_present=%s reason=%s",
        normalized_turn_id,
        match_mode,
        entries_before,
        len(entries),
        len(normalized_text),
        len(selected.assistant_text),
        selected.motion_payload is not None,
        selected.reason,
    )
    return selected


def start_parallel_motion_generation(
    event: Any,
    bundle: _MotionRuntimeBundle,
    *,
    tasks: set[asyncio.Task],
) -> asyncio.Task | None:
    existing = event.get_extra(INDEPENDENT_MOTION_TASK_EXTRA_KEY)
    if isinstance(existing, asyncio.Task):
        logger.info(
            "WIRING independent_motion.task_reused turn_id=%s",
            event.get_extra("_turn_id") or "<missing>",
        )
        return existing

    provider = getattr(bundle.runtime_state, "selected_independent_motion_provider", None)
    if provider is None:
        logger.warning(
            "WIRING independent_motion.skipped reason=provider_unavailable turn_id=%s",
            event.get_extra("_turn_id") or "<missing>",
        )
        return None

    task = asyncio.create_task(
        generate_independent_motion(
            event,
            bundle,
            provider=provider,
            assistant_text="",
        ),
        name="ag99live-independent-motion",
    )
    tasks.add(task)
    task.add_done_callback(tasks.discard)
    event.set_extra(INDEPENDENT_MOTION_TASK_EXTRA_KEY, task)
    logger.info(
        "WIRING independent_motion.task_started mode=parallel turn_id=%s "
        "provider=%s",
        event.get_extra("_turn_id") or "<missing>",
        getattr(bundle.runtime_state, "independent_motion_provider_id", "<missing>"),
    )
    return task


async def resolve_motion_after_llm_response(
    event: Any,
    bundle: _MotionRuntimeBundle,
    *,
    assistant_text: str,
    tasks: set[asyncio.Task],
) -> IndependentMotionResult | None:
    state = bundle.runtime_state
    if bool(getattr(state, "independent_motion_parallel", False)):
        task = event.get_extra(INDEPENDENT_MOTION_TASK_EXTRA_KEY)
        if not isinstance(task, asyncio.Task):
            logger.warning(
                "WIRING independent_motion.skipped reason=parallel_task_missing turn_id=%s",
                event.get_extra("_turn_id") or "<missing>",
            )
            return None
        logger.info(
            "WIRING independent_motion.task_await_started mode=parallel turn_id=%s",
            event.get_extra("_turn_id") or "<missing>",
        )
        try:
            # Keep the task alive on timeout so turn cleanup can still cancel it,
            # but never let a slow motion provider block the visible reply.
            result = await asyncio.wait_for(
                asyncio.shield(task),
                timeout=_PARALLEL_MOTION_WAIT_SECONDS,
            )
        except asyncio.TimeoutError:
            task.add_done_callback(_consume_background_motion_exception)
            logger.warning(
                "WIRING independent_motion.wait_timeout mode=parallel "
                "turn_id=%s timeout_seconds=%.2f",
                event.get_extra("_turn_id") or "<missing>",
                _PARALLEL_MOTION_WAIT_SECONDS,
            )
            return None
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "WIRING independent_motion.failed reason=parallel_task_failed error=%s",
                exc,
                exc_info=True,
            )
            return None
        logger.info(
            "WIRING independent_motion.task_completed mode=parallel turn_id=%s "
            "payload_present=%s reason=%s image_count=%s",
            event.get_extra("_turn_id") or "<missing>",
            result.motion_payload is not None,
            result.reason,
            result.image_count,
        )
        return replace(result, assistant_text=assistant_text.strip())

    provider = getattr(state, "selected_independent_motion_provider", None)
    if provider is None:
        logger.warning(
            "WIRING independent_motion.skipped reason=provider_unavailable turn_id=%s",
            event.get_extra("_turn_id") or "<missing>",
        )
        return None

    result_task = asyncio.create_task(
        generate_independent_motion(
            event,
            bundle,
            provider=provider,
            assistant_text=assistant_text.strip(),
        ),
        name="ag99live-independent-motion-serial",
    )
    tasks.add(result_task)
    result_task.add_done_callback(tasks.discard)
    event.set_extra(INDEPENDENT_MOTION_TASK_EXTRA_KEY, result_task)
    logger.info(
        "WIRING independent_motion.task_started mode=serial turn_id=%s provider=%s",
        event.get_extra("_turn_id") or "<missing>",
        getattr(state, "independent_motion_provider_id", "<missing>"),
    )
    try:
        result = await result_task
        logger.info(
            "WIRING independent_motion.task_completed mode=serial turn_id=%s "
            "payload_present=%s reason=%s image_count=%s",
            event.get_extra("_turn_id") or "<missing>",
            result.motion_payload is not None,
            result.reason,
            result.image_count,
        )
        return result
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "WIRING independent_motion.failed reason=serial_task_failed error=%s",
            exc,
            exc_info=True,
        )
        return None
    finally:
        if event.get_extra(INDEPENDENT_MOTION_TASK_EXTRA_KEY) is result_task:
            event.set_extra(INDEPENDENT_MOTION_TASK_EXTRA_KEY, None)


async def generate_independent_motion(
    event: Any,
    bundle: _MotionRuntimeBundle,
    *,
    provider: Any,
    assistant_text: str,
) -> IndependentMotionResult:
    images = _current_image_urls(event)
    turn_id = event.get_extra("_turn_id") or "<missing>"
    provider_id = getattr(bundle.runtime_state, "independent_motion_provider_id", "<missing>")
    mode = (
        "parallel"
        if bool(getattr(bundle.runtime_state, "independent_motion_parallel", False))
        else "serial"
    )

    def finish(
        *,
        motion_payload: dict[str, Any] | None,
        reason: str,
        image_count: int,
    ) -> IndependentMotionResult:
        result = IndependentMotionResult(
            assistant_text=assistant_text,
            motion_payload=motion_payload,
            reason=reason,
            image_count=image_count,
        )
        logger.info(
            "WIRING independent_motion.generation_completed turn_id=%s "
            "mode=%s provider=%s payload_present=%s reason=%s image_count=%s "
            "assistant_text_len=%s",
            turn_id,
            mode,
            provider_id,
            motion_payload is not None,
            reason,
            image_count,
            len(assistant_text),
        )
        return result

    logger.info(
        "WIRING independent_motion.generation_started turn_id=%s mode=%s "
        "provider=%s input_text_present=%s image_count=%s",
        turn_id,
        mode,
        provider_id,
        bool(str(getattr(event, "message_str", "") or "").strip()),
        len(images),
    )
    try:
        current_user_text = str(getattr(event, "message_str", "") or "").strip()
        if not current_user_text and not images:
            return finish(
                motion_payload=None,
                reason="current_input_missing",
                image_count=0,
            )

        history_turns = max(
            0,
            min(int(getattr(bundle.runtime_state, "independent_motion_history_turns", 6)), 20),
        )
        contexts = await _load_recent_history(
            event,
            bundle,
            history_turns=history_turns,
            current_user_text=current_user_text,
        )
        logger.info(
            "WIRING independent_motion.history_loaded turn_id=%s "
            "requested_turns=%s message_count=%s",
            turn_id,
            history_turns,
            len(contexts),
        )
        capability_payload = _build_motion_static_capability_payload(
            bundle.runtime_state
        )
        runtime_payload, reference_diagnostics = _build_motion_runtime_payload(
            event,
            bundle.turn_coordinator,
            bundle.runtime_state,
            capability_payload=capability_payload,
        )
        _record_motion_prompt_reference_observation(
            bundle=bundle,
            event=event,
            capability_payload=capability_payload,
            runtime_payload=runtime_payload,
            reference_diagnostics=reference_diagnostics,
            source_route="independent_provider",
        )

        prompt = _build_current_turn_prompt(
            current_user_text=current_user_text,
            assistant_text=assistant_text,
            image_count=len(images),
        )
        system_prompt = _build_independent_system_prompt(
            capability_payload=capability_payload,
            runtime_payload=runtime_payload,
        )
        logger.info(
            "WIRING independent_motion.provider_request_started turn_id=%s "
            "history_message_count=%s image_count=%s prompt_len=%s system_prompt_len=%s",
            turn_id,
            len(contexts),
            len(images),
            len(prompt),
            len(system_prompt),
        )
        response = await provider.text_chat(
            prompt=prompt,
            system_prompt=system_prompt,
            contexts=contexts or None,
            image_urls=images or None,
        )
        response_text = str(getattr(response, "completion_text", "") or "").strip()
        logger.info(
            "WIRING independent_motion.provider_response_received turn_id=%s "
            "response_len=%s",
            turn_id,
            len(response_text),
        )
        if not response_text:
            return finish(
                motion_payload=None,
                reason="provider_response_empty",
                image_count=len(images),
            )
        try:
            raw_arguments = _parse_motion_json(response_text)
        except (TypeError, ValueError, json.JSONDecodeError) as exc:
            logger.warning(
                "WIRING independent_motion.json_parse_failed turn_id=%s "
                "error=%s",
                turn_id,
                type(exc).__name__,
            )
            return finish(
                motion_payload=None,
                reason="json_parse_failed:" + type(exc).__name__,
                image_count=len(images),
            )
        shape_summary = _motion_output_shape_summary(raw_arguments)
        logger.info(
            "WIRING independent_motion.json_parsed turn_id=%s field_count=%s "
            "shape=%s root_axis_count=%s step_count=%s step_axis_counts=%s "
            "unique_axis_count=%s",
            turn_id,
            len(raw_arguments),
            shape_summary["shape"],
            shape_summary["root_axis_count"],
            shape_summary["step_count"],
            ",".join(
                str(value)
                for value in shape_summary["step_axis_counts"]
            ),
            shape_summary["unique_axis_count"],
        )
        unknown_fields = sorted(
            set(raw_arguments)
            - {
                "intent_tags",
                "axis_levels",
                "motion_steps",
                "duration_hint_ms",
                "expression_resource_id",
                "motion_resource_id",
            }
        )
        if unknown_fields:
            logger.warning(
                "WIRING independent_motion.output_rejected turn_id=%s "
                "reason=unknown_output_fields field_count=%s",
                turn_id,
                len(unknown_fields),
            )
            return finish(
                motion_payload=None,
                reason="unknown_output_fields:" + ",".join(unknown_fields),
                image_count=len(images),
            )

        motion_payload, reason = normalize_motion_arguments_payload(
            raw_arguments,
            bundle.runtime_state,
            base_reason="independent_provider",
            append_resolution_reason=_append_resolution_reason,
            sanitize_reason_fragment=_sanitize_reason_fragment,
        )
        if motion_payload is None:
            shape_summary = _motion_output_shape_summary(raw_arguments)
            logger.warning(
                "WIRING independent_motion.normalization_failed turn_id=%s "
                "reason=%s shape=%s root_axis_count=%s step_count=%s "
                "step_axis_counts=%s unique_axis_count=%s",
                turn_id,
                reason,
                shape_summary["shape"],
                shape_summary["root_axis_count"],
                shape_summary["step_count"],
                ",".join(str(value) for value in shape_summary["step_axis_counts"]),
                shape_summary["unique_axis_count"],
            )
            return finish(
                motion_payload=None,
                reason=reason,
                image_count=len(images),
            )
        logger.info(
            "WIRING independent_motion.normalization_succeeded turn_id=%s "
            "reason=%s",
            turn_id,
            reason,
        )
        return finish(
            motion_payload=motion_payload,
            reason=reason,
            image_count=len(images),
        )
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "WIRING independent_motion.failed turn_id=%s provider=%s error=%s",
            turn_id,
            provider_id,
            exc,
            exc_info=True,
        )
        return finish(
            motion_payload=None,
            reason="independent_provider_failed:" + type(exc).__name__,
            image_count=len(images),
        )


async def _load_recent_history(
    event: Any,
    bundle: _MotionRuntimeBundle,
    *,
    history_turns: int,
    current_user_text: str,
) -> list[dict[str, str]]:
    if history_turns <= 0:
        return []
    plugin_context = getattr(bundle.runtime_state, "plugin_context", None)
    conversation_manager = getattr(plugin_context, "conversation_manager", None)
    if conversation_manager is None:
        return []
    try:
        origin = str(getattr(event, "unified_msg_origin", "") or "").strip()
        if not origin:
            return []
        conversation_id = await conversation_manager.get_curr_conversation_id(origin)
        if not conversation_id:
            return []
        conversation = await conversation_manager.get_conversation(origin, conversation_id)
        history = getattr(conversation, "history", None)
        if isinstance(history, str):
            history = json.loads(history)
        if isinstance(history, Mapping):
            history = history.get("messages", history.get("history", []))
        if not isinstance(history, list):
            return []

        rounds = _group_history_rounds(history)
        if rounds and current_user_text:
            current_round_user = rounds[-1][0]["content"]
            if current_round_user == current_user_text:
                rounds.pop()
        contexts = [message for turn in rounds[-history_turns:] for message in turn]
        logger.info(
            "WIRING independent_motion.history_resolved turn_id=%s "
            "round_count=%s message_count=%s",
            event.get_extra("_turn_id") or "<missing>",
            min(len(rounds), history_turns),
            len(contexts),
        )
        return contexts
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "WIRING independent_motion.history_unavailable turn_id=%s error=%s",
            event.get_extra("_turn_id") or "<missing>",
            exc,
        )
        return []


def _group_history_rounds(history: list[Any]) -> list[list[dict[str, str]]]:
    rounds: list[list[dict[str, str]]] = []
    current_round: list[dict[str, str]] = []
    for raw_message in history:
        if not isinstance(raw_message, Mapping):
            continue
        role = str(raw_message.get("role") or "").strip().lower()
        content = _history_message_text(raw_message.get("content"))
        if role == "user":
            if current_round:
                rounds.append(current_round)
            current_round = [{"role": role, "content": content}]
        elif role == "assistant" and current_round:
            current_round.append({"role": role, "content": content})
    if current_round:
        rounds.append(current_round)
    return [turn for turn in rounds if any(message["content"] for message in turn)]


def _history_message_text(value: Any) -> str:
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, list):
        fragments = []
        for part in value:
            if isinstance(part, str):
                fragments.append(part)
            elif isinstance(part, Mapping):
                text = part.get("text")
                if isinstance(text, str) and str(part.get("type") or "text") == "text":
                    fragments.append(text)
        return "\n".join(fragment.strip() for fragment in fragments if fragment.strip())
    return ""


def _current_image_urls(event: Any) -> list[str]:
    message_obj = getattr(event, "message_obj", None)
    raw_message = getattr(message_obj, "raw_message", None)
    if not isinstance(raw_message, Mapping):
        return []
    if raw_message.get("reused_desktop_snapshot"):
        return []
    resolved_images = raw_message.get("resolved_images")
    if not isinstance(resolved_images, list):
        return []
    return [
        image_url
        for item in resolved_images
        if isinstance(item, Mapping)
        and item.get("type") == "input_image"
        and isinstance((image_url := item.get("image_url")), str)
        and image_url.strip()
    ]


def _build_current_turn_prompt(
    *,
    current_user_text: str,
    assistant_text: str,
    image_count: int,
) -> str:
    current_user_text = current_user_text or "（本轮没有文字输入）"
    prompt = f"本轮用户输入：\n{current_user_text}"
    if image_count:
        prompt += f"\n\n本轮附带了 {image_count} 张图片，请结合图片判断动作。"
    if assistant_text:
        prompt += f"\n\n主对话模型本轮回复：\n{assistant_text}"
    prompt += "\n\n请仅为这轮交互生成一个 Live2D 动作意图。"
    return prompt


def _build_independent_system_prompt(
    *,
    capability_payload: dict[str, Any],
    runtime_payload: dict[str, Any],
) -> str:
    capability = _build_motion_capability_prompt_payload(capability_payload)
    motion_resource = next(
        (
            str(resource.get("resource_id") or "").strip()
            for resource in capability.get("resources", [])
            if isinstance(resource, Mapping)
            and resource.get("resource_type") == "motion"
            and str(resource.get("resource_id") or "").strip()
        ),
        "",
    )
    contract: dict[str, Any] = {"intent_tags": ["用简短关键词概括当前表达"]}
    if motion_resource:
        contract["motion_resource_id"] = motion_resource
    else:
        first_axis = next(
            (
                axis
                for axis in capability.get("axes", [])
                if isinstance(axis, Mapping)
                and str(axis.get("id") or "").strip()
                and axis.get("available_levels")
            ),
            None,
        )
        if first_axis is not None:
            raw_levels = first_axis.get("available_levels")
            levels = list(raw_levels) if isinstance(raw_levels, (list, tuple)) else []
            level = 0 if 0 in levels else levels[0]
            contract["axis_levels"] = {str(first_axis["id"]): level}
    return (
        "你负责为 AG99live 的 Live2D 角色生成动作参数。"
        "根据最近对话、当前用户输入、当前轮图片以及当前回复（如果提供），"
        "只描述角色本轮应该呈现的动作。"
        "只输出一个 JSON 对象，不要 Markdown、解释文字、工具调用或额外字段。"
        "必需字段 intent_tags 是 1 到 6 个简短关键词。执行形状必须且只能选择一种："
        "axis_levels（单个姿态）、motion_steps（2 到 4 个动作步骤，每步必须包含 axis_levels 和 1 到 3 的 duration_weight），"
        "或 motion_resource_id（完整动作资源）。axis_levels 的值必须是能力数据里对应轴可用的等级。"
        "动作序列采用稀疏语义：每一步只写新开始控制或需要改变的轴，后续步骤可以新增或省略轴；"
        "不设整段动作的固定轴数量上限，但每个轴 ID 和等级都必须来自能力数据。"
        "可选字段只有 duration_hint_ms、expression_resource_id、motion_resource_id；"
        "motion_resource_id 不得和 axis_levels、motion_steps 或 duration_hint_ms 同时使用；"
        "expression_resource_id 不得和 motion_resource_id 同时使用。"
        "不要输出 profile_id、profile_revision、model_id、schema_version，这些由程序补入。"
        f"JSON 形状示例：{json.dumps(contract, ensure_ascii=False, separators=(',', ':'))}\n\n"
        "Live2D 能力：\n"
        f"{json.dumps(capability, ensure_ascii=False, separators=(',', ':'))}\n\n"
        "当前动作上下文：\n"
        f"{json.dumps(runtime_payload, ensure_ascii=False, separators=(',', ':'))}"
    )


def _parse_motion_json(value: str) -> dict[str, Any]:
    normalized = value.strip()
    if normalized.startswith("```"):
        lines = normalized.splitlines()
        if len(lines) >= 3 and lines[-1].strip() == "```":
            normalized = "\n".join(lines[1:-1]).strip()
    payload = json.loads(normalized)
    if not isinstance(payload, dict):
        raise ValueError("independent_motion_output_not_object")
    return payload


def _motion_output_shape(value: Mapping[str, Any]) -> str:
    if "motion_resource_id" in value:
        return "motion_resource"
    if "motion_steps" in value:
        return "motion_steps"
    if "axis_levels" in value:
        return "axis_levels"
    return "missing"


def _motion_output_shape_summary(value: Mapping[str, Any]) -> dict[str, Any]:
    root_axes = value.get("axis_levels")
    root_axis_ids = {
        str(axis_id).strip()
        for axis_id in root_axes
        if str(axis_id).strip()
    } if isinstance(root_axes, Mapping) else set()
    raw_steps = value.get("motion_steps")
    step_axis_counts: list[int] = []
    unique_axis_ids = set(root_axis_ids)
    if isinstance(raw_steps, list):
        for raw_step in raw_steps:
            step_axes = (
                raw_step.get("axis_levels")
                if isinstance(raw_step, Mapping)
                else None
            )
            if isinstance(step_axes, Mapping):
                step_ids = {
                    str(axis_id).strip()
                    for axis_id in step_axes
                    if str(axis_id).strip()
                }
                step_axis_counts.append(len(step_ids))
                unique_axis_ids.update(step_ids)
            else:
                step_axis_counts.append(0)
    return {
        "shape": _motion_output_shape(value),
        "root_axis_count": len(root_axis_ids),
        "step_count": len(raw_steps) if isinstance(raw_steps, list) else 0,
        "step_axis_counts": step_axis_counts,
        "unique_axis_count": len(unique_axis_ids),
    }


__all__ = [
    "INDEPENDENT_MOTION_RESULT_EXTRA_KEY",
    "INDEPENDENT_MOTION_TASK_EXTRA_KEY",
    "IndependentMotionResult",
    "generate_independent_motion",
    "is_persona_expression_request",
    "resolve_motion_after_llm_response",
    "store_motion_result_for_turn",
    "start_parallel_motion_generation",
    "take_motion_result_for_turn",
]
