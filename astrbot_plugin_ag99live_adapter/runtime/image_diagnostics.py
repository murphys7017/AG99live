from __future__ import annotations

from typing import Any

from astrbot.api import logger

from ..protocol.builder import build_control_error


async def emit_image_input_diagnostics(
    *,
    message_obj: Any,
    client_uid: str,
    current_turn_id: str | None,
    send_json: Any,
) -> None:
    raw_message = getattr(message_obj, "raw_message", None)
    if not isinstance(raw_message, dict):
        return

    diagnostics = raw_message.get("image_input_diagnostics")
    if not isinstance(diagnostics, list) or not diagnostics:
        return

    cooldown_diagnostics = [
        item for item in diagnostics
        if isinstance(item, dict) and str(item.get("reason") or "").strip() == "cooldown_window"
    ]
    if cooldown_diagnostics:
        remaining_seconds = max(
            int(str(item.get("remaining_seconds") or "0") or "0")
            for item in cooldown_diagnostics
        )
        cooldown_message = (
            "Image input skipped by cooldown window. "
            f"Wait about {remaining_seconds}s, or set `image_cooldown_seconds` to 0."
        )
        logger.info("Image input diagnostics: %s", cooldown_message)
        await send_json(
            build_control_error(
                turn_id=current_turn_id,
                message=cooldown_message,
            )
        )

    actionable_reasons = [
        str(item.get("reason") or "").strip()
        for item in diagnostics
        if isinstance(item, dict)
        and str(item.get("reason") or "").strip()
        and str(item.get("reason") or "").strip() != "cooldown_window"
    ]
    if not actionable_reasons:
        return

    counts: dict[str, int] = {}
    for reason in actionable_reasons:
        counts[reason] = counts.get(reason, 0) + 1

    parts = [
        f"{count} image(s) {describe_image_input_reason(reason)}"
        for reason, count in counts.items()
    ]
    message = "Some images were ignored: " + "; ".join(parts) + "."
    logger.warning("Image input diagnostics: %s", message)
    await send_json(
        build_control_error(
            turn_id=current_turn_id,
            message=message,
        )
    )


def describe_image_input_reason(reason: str) -> str:
    descriptions = {
        "unsupported_image_payload": "used an unsupported payload format",
        "unsupported_data_uri": "used an unsupported data URI format",
        "invalid_base64_payload": "could not be decoded",
        "invalid_local_path": "used an invalid local file path",
        "local_path_outside_allowed_roots": "were outside the allowed local folders",
        "unsupported_local_suffix": "used an unsupported local file suffix",
        "local_read_failed": "could not be read from disk",
        "image_too_large": "were too large",
        "empty_image_payload": "were empty",
    }
    return descriptions.get(reason, "failed validation")
