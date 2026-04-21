from __future__ import annotations

import hashlib
import json
from typing import Any


ACTION_FILTER_SYSTEM_PROMPT = """你是 Live2D 基础动作筛选器。

目标：
从候选原子动作中，筛选一组“通用、可复用、基础覆盖”的动作。

硬性要求：
1. 只能使用输入里已经给出的 atom id。
2. 不要发明新 id，不要改写 id。
3. 优先覆盖基础头部/身体/眼睛/眉毛/嘴部/视线/呼吸。
4. 避免过于剧情化、主题化、特殊道具化的动作。
5. 输出必须是 JSON，不要输出任何额外文本。

输出格式：
{
  "selected_atom_ids_by_channel": {
    "channel_name": ["atom_id_1", "atom_id_2"]
  },
  "reason": "简短说明"
}
"""


class ActionFilterDecisionError(ValueError):
    pass


def build_action_filter_signature(base_action_library: dict[str, Any]) -> str:
    digest_payload = {
        "schema_version": base_action_library.get("schema_version", ""),
        "channels": [
            {
                "name": str(channel.get("name") or ""),
                "available": bool(channel.get("available")),
                "atom_ids": list(channel.get("atom_ids", [])),
            }
            for channel in base_action_library.get("channels", [])
            if isinstance(channel, dict)
        ],
        "atoms": [
            {
                "id": str(atom.get("id") or ""),
                "channel": str(atom.get("channel") or ""),
                "polarity": str(atom.get("polarity") or ""),
                "semantic_polarity": str(atom.get("semantic_polarity") or ""),
                "trait": str(atom.get("trait") or ""),
                "strength": str(atom.get("strength") or ""),
                "score": float(atom.get("score") or 0.0),
                "energy_score": float(atom.get("energy_score") or 0.0),
            }
            for atom in base_action_library.get("atoms", [])
            if isinstance(atom, dict)
        ],
    }
    encoded = json.dumps(digest_payload, ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def build_action_filter_prompt(
    base_action_library: dict[str, Any],
    *,
    max_atoms_per_channel: int = 2,
) -> str:
    input_payload = _build_action_filter_input_payload(
        base_action_library,
        max_atoms_per_channel=max_atoms_per_channel,
    )
    prompt = (
        "请根据输入候选动作，筛选通用基础动作。\n"
        f"每个 channel 最多保留 {max_atoms_per_channel} 个 atom。\n"
        "必须只使用候选 atom id。\n"
        "只输出 JSON。\n\n"
        f"{json.dumps(input_payload, ensure_ascii=False, sort_keys=True)}"
    )
    return f"{prompt}\n/no_think"


def parse_action_filter_decision(
    raw_text: str,
    *,
    base_action_library: dict[str, Any],
    max_atoms_per_channel: int = 2,
) -> dict[str, list[str]]:
    payload = _load_json_payload(raw_text)
    if not isinstance(payload, dict):
        raise ActionFilterDecisionError("LLM output must be a JSON object.")

    allow_map = _build_channel_allow_map(base_action_library)
    selected_by_channel: dict[str, list[str]] = {channel_name: [] for channel_name in allow_map}

    raw_map = payload.get("selected_atom_ids_by_channel")
    if isinstance(raw_map, dict):
        for channel_name, atom_ids in raw_map.items():
            normalized_channel = str(channel_name or "").strip()
            if not normalized_channel or normalized_channel not in allow_map:
                continue
            selected_by_channel[normalized_channel] = _normalize_atom_id_list(
                atom_ids,
                allow_ids=allow_map[normalized_channel],
                limit=max_atoms_per_channel,
            )
    else:
        raw_selections = payload.get("selections")
        if isinstance(raw_selections, list):
            for item in raw_selections:
                if not isinstance(item, dict):
                    continue
                channel_name = str(item.get("channel") or "").strip()
                if not channel_name or channel_name not in allow_map:
                    continue
                merged = selected_by_channel[channel_name] + _normalize_atom_id_list(
                    item.get("atom_ids"),
                    allow_ids=allow_map[channel_name],
                    limit=max_atoms_per_channel,
                )
                selected_by_channel[channel_name] = _deduplicate_preserve_order(merged)[
                    :max_atoms_per_channel
                ]

    return selected_by_channel


def apply_action_filter_selection(
    base_action_library: dict[str, Any],
    *,
    selected_atom_ids_by_channel: dict[str, list[str]],
    analysis: dict[str, Any],
) -> None:
    channels = [
        item
        for item in base_action_library.get("channels", [])
        if isinstance(item, dict)
    ]
    atoms = [
        item
        for item in base_action_library.get("atoms", [])
        if isinstance(item, dict)
    ]
    atom_by_id = {str(atom.get("id") or ""): atom for atom in atoms if atom.get("id")}
    channel_map = {
        str(channel.get("name") or ""): channel
        for channel in channels
        if channel.get("name")
    }

    selected_atom_ids: list[str] = []
    selected_channel_count = 0

    for channel in channels:
        channel_name = str(channel.get("name") or "")
        selected = _deduplicate_preserve_order(
            [
                atom_id
                for atom_id in selected_atom_ids_by_channel.get(channel_name, [])
                if atom_id in atom_by_id
            ]
        )
        channel["atom_ids"] = selected
        channel["selected_atom_count"] = len(selected)
        channel["polarity_modes"] = sorted(
            {
                str(atom_by_id[atom_id].get("polarity") or "")
                for atom_id in selected
                if atom_by_id.get(atom_id)
            }
        )
        if selected:
            selected_channel_count += 1
        selected_atom_ids.extend(selected)

    selected_atom_ids = _deduplicate_preserve_order(selected_atom_ids)
    base_action_library["atoms"] = [
        atom_by_id[atom_id] for atom_id in selected_atom_ids if atom_id in atom_by_id
    ]

    families = [
        item
        for item in base_action_library.get("families", [])
        if isinstance(item, dict)
    ]
    for family in families:
        family_channel_names = [
            str(name).strip()
            for name in family.get("channels", [])
            if str(name).strip()
        ]
        family_atom_ids: list[str] = []
        for channel_name in family_channel_names:
            channel_payload = channel_map.get(channel_name)
            if not channel_payload:
                continue
            family_atom_ids.extend(channel_payload.get("atom_ids", []))
        family_atom_ids = _deduplicate_preserve_order(family_atom_ids)
        family["atom_ids"] = family_atom_ids
        family["atom_count"] = len(family_atom_ids)

    summary = dict(base_action_library.get("summary") or {})
    summary["selected_atom_count"] = len(base_action_library["atoms"])
    summary["selected_channel_count"] = selected_channel_count
    base_action_library["summary"] = summary
    base_action_library["analysis"] = dict(analysis)


def count_selected_channels(selected_atom_ids_by_channel: dict[str, list[str]]) -> int:
    return len([key for key, value in selected_atom_ids_by_channel.items() if key and value])


def _build_action_filter_input_payload(
    base_action_library: dict[str, Any],
    *,
    max_atoms_per_channel: int,
) -> dict[str, Any]:
    atoms = [
        item
        for item in base_action_library.get("atoms", [])
        if isinstance(item, dict)
    ]
    atom_by_id = {str(atom.get("id") or ""): atom for atom in atoms if atom.get("id")}

    channels_payload: list[dict[str, Any]] = []
    for channel in base_action_library.get("channels", []):
        if not isinstance(channel, dict):
            continue
        channel_name = str(channel.get("name") or "").strip()
        if not channel_name:
            continue
        candidate_atoms: list[dict[str, Any]] = []
        for atom_id in channel.get("atom_ids", []):
            atom = atom_by_id.get(str(atom_id))
            if not atom:
                continue
            candidate_atoms.append(
                {
                    "id": str(atom.get("id") or ""),
                    "polarity": str(atom.get("polarity") or ""),
                    "semantic_polarity": str(atom.get("semantic_polarity") or ""),
                    "trait": str(atom.get("trait") or ""),
                    "strength": str(atom.get("strength") or ""),
                    "score": round(float(atom.get("score") or 0.0), 4),
                    "energy_score": round(float(atom.get("energy_score") or 0.0), 4),
                    "source_motion": str(atom.get("source_motion") or ""),
                    "source_category": str(atom.get("source_category") or ""),
                    "duration": round(float(atom.get("duration") or 0.0), 4),
                }
            )

        candidate_atoms.sort(
            key=lambda atom: (
                -float(atom.get("score") or 0.0),
                -float(atom.get("energy_score") or 0.0),
                str(atom.get("id") or ""),
            )
        )
        channels_payload.append(
            {
                "name": channel_name,
                "label": str(channel.get("label") or channel_name),
                "family": str(channel.get("family") or ""),
                "domain": str(channel.get("domain") or ""),
                "available": bool(channel.get("available")),
                "candidate_component_count": int(channel.get("candidate_component_count") or 0),
                "candidates": candidate_atoms[: max(max_atoms_per_channel * 4, 8)],
            }
        )

    return {
        "schema_version": base_action_library.get("schema_version", ""),
        "focus_channels": list(base_action_library.get("focus_channels", [])),
        "focus_domains": list(base_action_library.get("focus_domains", [])),
        "selection_constraints": {
            "max_atoms_per_channel": max_atoms_per_channel,
            "must_use_existing_atom_ids_only": True,
            "prefer_generic_base_actions": True,
        },
        "channels": channels_payload,
    }


def _build_channel_allow_map(base_action_library: dict[str, Any]) -> dict[str, set[str]]:
    allow_map: dict[str, set[str]] = {}
    for channel in base_action_library.get("channels", []):
        if not isinstance(channel, dict):
            continue
        channel_name = str(channel.get("name") or "").strip()
        if not channel_name:
            continue
        allow_map[channel_name] = {
            str(atom_id).strip()
            for atom_id in channel.get("atom_ids", [])
            if str(atom_id).strip()
        }
    return allow_map


def _normalize_atom_id_list(
    value: Any,
    *,
    allow_ids: set[str],
    limit: int,
) -> list[str]:
    if not isinstance(value, list):
        return []
    normalized: list[str] = []
    for item in value:
        atom_id = str(item or "").strip()
        if not atom_id or atom_id not in allow_ids:
            continue
        normalized.append(atom_id)
    normalized = _deduplicate_preserve_order(normalized)
    return normalized[: max(limit, 1)]


def _deduplicate_preserve_order(values: list[str]) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for value in values:
        if not value or value in seen:
            continue
        seen.add(value)
        result.append(value)
    return result


def _load_json_payload(raw_text: str) -> Any:
    text = (raw_text or "").strip()
    if not text:
        raise ActionFilterDecisionError("LLM output is empty.")

    if text.startswith("```"):
        lines = text.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        text = "\n".join(lines).strip()

    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end != -1 and end > start:
        text = text[start : end + 1]

    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        raise ActionFilterDecisionError(f"Invalid JSON output: {exc}") from exc
