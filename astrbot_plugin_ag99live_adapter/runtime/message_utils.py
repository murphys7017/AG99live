from __future__ import annotations

from typing import Any
from uuid import uuid4

from astrbot.api.message_components import Image, Plain, Record


def resolve_platform_segment_message_id(platform_extras: dict[str, Any]) -> str:
    for key in ("visible_message_id", "composite_message_id", "message_id"):
        value = platform_extras.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return uuid4().hex


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


def extract_outbound_message_parts(message_chain) -> tuple[list[str], list[str], list[str]]:
    texts: list[str] = []
    picture_paths: list[str] = []
    record_paths: list[str] = []

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
            texts.append(component_text.strip())

        if isinstance(image_path, str) and image_path:
            record_paths.append(image_path)

    return texts, picture_paths, record_paths
