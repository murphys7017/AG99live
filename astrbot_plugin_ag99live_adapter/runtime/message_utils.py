from __future__ import annotations

from typing import Any

from astrbot.api.message_components import Image, Plain, Record


def resolve_platform_segment_message_id(platform_extras: dict[str, Any]) -> str:
    output_segment = platform_extras.get("output_segment")
    if isinstance(output_segment, dict):
        message_id = output_segment.get("message_id")
        if isinstance(message_id, str) and message_id.strip():
            return message_id.strip()

    # ``composite_message_id`` is allocated once per logical delivery call.
    # Prefer it over the legacy visible-id normalization so separate progress
    # messages do not collapse into one segment and conflict on updated text.
    composite_message_id = platform_extras.get("composite_message_id")
    if isinstance(composite_message_id, str) and composite_message_id.strip():
        return composite_message_id.strip()

    logical_message_id = platform_extras.get("logical_message_id")
    if isinstance(logical_message_id, str) and logical_message_id.strip():
        return logical_message_id.strip()

    visible_message_id = platform_extras.get("visible_message_id")
    message_kind = platform_extras.get("message_kind")
    if isinstance(visible_message_id, str) and isinstance(message_kind, str):
        normalized_visible_id = visible_message_id.strip()
        normalized_kind = message_kind.strip()
        marker = f"::{normalized_kind}::"
        prefix, separator, sequence = normalized_visible_id.rpartition(marker)
        if separator and prefix and sequence.isdigit():
            return f"{prefix}::{normalized_kind}"

    for key in ("visible_message_id", "composite_message_id", "message_id"):
        value = platform_extras.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    raise ValueError("output_segment_message_id_missing")


def iter_platform_motion_client_objects(
    platform_extras: dict[str, Any],
) -> list[dict[str, Any]]:
    client_objects = platform_extras.get("client_objects")
    if not isinstance(client_objects, list):
        return []

    motion_objects: list[dict[str, Any]] = []
    for item in client_objects:
        if not isinstance(item, dict):
            continue
        object_type = str(item.get("type") or "").strip()
        if object_type not in {
            "ag99live.motion_payload",
            "engine.motion_intent",
            "motion_intent",
        }:
            continue
        motion_objects.append(item)
    return motion_objects


def iter_message_chain(message_chain) -> list[Any]:
    if message_chain is None:
        return []
    if hasattr(message_chain, "chain") and isinstance(message_chain.chain, list):
        return message_chain.chain
    if isinstance(message_chain, list):
        return message_chain
    return [message_chain]


def extract_outbound_message_parts(message_chain) -> tuple[list[str], list[str], list[str], list[str]]:
    texts: list[str] = []
    picture_paths: list[str] = []
    record_paths: list[str] = []
    record_texts: list[str] = []

    for component in iter_message_chain(message_chain):
        component_text = getattr(component, "text", None)
        if isinstance(component, Plain) and isinstance(component_text, str) and component_text.strip():
            texts.append(component_text.strip())
            continue

        image_path = getattr(component, "file", None)
        if isinstance(component, Image) and isinstance(image_path, str) and image_path:
            picture_paths.append(image_path)
            continue

        if not isinstance(component, Record):
            continue

        if isinstance(component_text, str) and component_text.strip():
            record_texts.append(component_text.strip())

        if isinstance(image_path, str) and image_path:
            record_paths.append(image_path)

    return texts, picture_paths, record_paths, record_texts
