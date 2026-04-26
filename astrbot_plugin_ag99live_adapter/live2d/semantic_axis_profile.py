from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, NotRequired, TypedDict

SEMANTIC_AXIS_PROFILE_SCHEMA_VERSION = "ag99.semantic_axis_profile.v1"
SEMANTIC_AXIS_PROFILE_DIRNAME = "ag99"
SEMANTIC_AXIS_PROFILE_FILENAME = "semantic_axis_profile.json"
ALLOWED_CONTROL_ROLES = {"primary", "hint", "derived", "runtime", "ambient", "debug"}
ALLOWED_COUPLING_MODES = {"same_direction", "opposite_direction"}


class SemanticAxisProfileError(ValueError):
    pass


class SemanticAxisProfileRevisionError(SemanticAxisProfileError):
    pass


class SemanticAxisParameterBinding(TypedDict):
    parameter_id: str
    input_range: list[float]
    output_range: list[float]
    default_weight: float
    invert: bool
    parameter_name: NotRequired[str]


class SemanticAxisDefinition(TypedDict):
    id: str
    label: str
    description: str
    semantic_group: str
    control_role: str
    neutral: float
    value_range: list[float]
    soft_range: list[float]
    strong_range: list[float]
    positive_semantics: list[str]
    negative_semantics: list[str]
    usage_notes: str
    parameter_bindings: list[SemanticAxisParameterBinding]


class SemanticAxisCoupling(TypedDict):
    id: str
    source_axis_id: str
    target_axis_id: str
    mode: str
    scale: float
    deadzone: float
    max_delta: float


class SemanticAxisProfile(TypedDict):
    schema_version: str
    profile_id: str
    model_id: str
    source_hash: str
    last_scanned_hash: str
    revision: int
    status: str
    user_modified: bool
    generated_at: str
    updated_at: str
    axes: list[SemanticAxisDefinition]
    couplings: list[SemanticAxisCoupling]


_AXIS_ORDER = (
    "head_yaw",
    "head_pitch",
    "head_roll",
    "body_yaw",
    "body_roll",
    "gaze_x",
    "gaze_y",
    "eye_open_left",
    "eye_open_right",
    "mouth_open",
    "mouth_smile",
    "brow_bias",
)

_AXIS_DEFAULTS: dict[str, dict[str, Any]] = {
    "head_yaw": {
        "label": "Head Yaw",
        "description": "Controls left-right head orientation.",
        "semantic_group": "head",
        "control_role": "primary",
        "positive_semantics": ["look right", "turn right", "side glance right"],
        "negative_semantics": ["look left", "turn left", "avoid left"],
        "usage_notes": "Keep near neutral during ordinary speech.",
        "output_range": [-30.0, 30.0],
        "soft_range": [42.0, 58.0],
        "strong_range": [30.0, 70.0],
    },
    "head_pitch": {
        "label": "Head Pitch",
        "description": "Controls up-down head orientation.",
        "semantic_group": "head",
        "control_role": "primary",
        "positive_semantics": ["look up", "raise chin", "confident lift"],
        "negative_semantics": ["look down", "lower chin", "bashful drop"],
        "usage_notes": "Avoid holding extreme pitch for long spans.",
        "output_range": [-30.0, 30.0],
        "soft_range": [43.0, 57.0],
        "strong_range": [32.0, 68.0],
    },
    "head_roll": {
        "label": "Head Roll",
        "description": "Controls side tilt of the head.",
        "semantic_group": "head",
        "control_role": "primary",
        "positive_semantics": ["tilt right", "playful lean", "curious angle"],
        "negative_semantics": ["tilt left", "skeptical lean", "guarded angle"],
        "usage_notes": "Use in short accents rather than sustained loops.",
        "output_range": [-30.0, 30.0],
        "soft_range": [44.0, 56.0],
        "strong_range": [34.0, 66.0],
    },
    "body_yaw": {
        "label": "Body Yaw",
        "description": "Controls left-right upper-body orientation.",
        "semantic_group": "body",
        "control_role": "derived",
        "positive_semantics": ["body follows right", "lean right"],
        "negative_semantics": ["body follows left", "lean left"],
        "usage_notes": "Usually follows head yaw at lower intensity.",
        "output_range": [-10.0, 10.0],
        "soft_range": [46.0, 54.0],
        "strong_range": [38.0, 62.0],
    },
    "body_roll": {
        "label": "Body Roll",
        "description": "Controls side tilt of the torso.",
        "semantic_group": "body",
        "control_role": "derived",
        "positive_semantics": ["body tilt right", "relaxed sway"],
        "negative_semantics": ["body tilt left", "counter sway"],
        "usage_notes": "Keep subtle unless explicitly stylized.",
        "output_range": [-10.0, 10.0],
        "soft_range": [46.0, 54.0],
        "strong_range": [38.0, 62.0],
    },
    "gaze_x": {
        "label": "Gaze X",
        "description": "Controls left-right eye target direction.",
        "semantic_group": "gaze",
        "control_role": "primary",
        "positive_semantics": ["eyes right", "track right"],
        "negative_semantics": ["eyes left", "track left"],
        "usage_notes": "Usually leads head yaw by a small amount.",
        "output_range": [-1.0, 1.0],
        "soft_range": [44.0, 56.0],
        "strong_range": [30.0, 70.0],
    },
    "gaze_y": {
        "label": "Gaze Y",
        "description": "Controls up-down eye target direction.",
        "semantic_group": "gaze",
        "control_role": "primary",
        "positive_semantics": ["eyes up", "lift gaze"],
        "negative_semantics": ["eyes down", "drop gaze"],
        "usage_notes": "Combine with pitch sparingly to avoid overacting.",
        "output_range": [-1.0, 1.0],
        "soft_range": [44.0, 56.0],
        "strong_range": [30.0, 70.0],
    },
    "eye_open_left": {
        "label": "Eye Open Left",
        "description": "Controls openness of the left eye.",
        "semantic_group": "eye",
        "control_role": "runtime",
        "positive_semantics": ["open left eye", "alert left eye"],
        "negative_semantics": ["close left eye", "wink left"],
        "usage_notes": "Commonly shared with blink runtime.",
        "output_range": [0.0, 1.0],
        "soft_range": [50.0, 100.0],
        "strong_range": [0.0, 100.0],
    },
    "eye_open_right": {
        "label": "Eye Open Right",
        "description": "Controls openness of the right eye.",
        "semantic_group": "eye",
        "control_role": "runtime",
        "positive_semantics": ["open right eye", "alert right eye"],
        "negative_semantics": ["close right eye", "wink right"],
        "usage_notes": "Commonly shared with blink runtime.",
        "output_range": [0.0, 1.0],
        "soft_range": [50.0, 100.0],
        "strong_range": [0.0, 100.0],
    },
    "mouth_open": {
        "label": "Mouth Open",
        "description": "Controls mouth openness for speech and expression.",
        "semantic_group": "mouth",
        "control_role": "runtime",
        "positive_semantics": ["open mouth", "speak wider"],
        "negative_semantics": ["close mouth", "rest mouth"],
        "usage_notes": "Often driven by lip-sync runtime instead of prompt.",
        "output_range": [0.0, 1.0],
        "soft_range": [48.0, 72.0],
        "strong_range": [40.0, 100.0],
    },
    "mouth_smile": {
        "label": "Mouth Smile",
        "description": "Controls smile-vs-frown mouth form.",
        "semantic_group": "mouth",
        "control_role": "primary",
        "positive_semantics": ["smile", "warm grin"],
        "negative_semantics": ["frown", "tight mouth"],
        "usage_notes": "Blend gently with speaking mouth shapes.",
        "output_range": [-1.0, 1.0],
        "soft_range": [44.0, 60.0],
        "strong_range": [30.0, 75.0],
    },
    "brow_bias": {
        "label": "Brow Bias",
        "description": "Controls brow raise-vs-frown bias.",
        "semantic_group": "brow",
        "control_role": "derived",
        "positive_semantics": ["raise brow", "curious brow"],
        "negative_semantics": ["furrow brow", "tense brow"],
        "usage_notes": "Best used as a secondary emotional hint.",
        "output_range": [-1.0, 1.0],
        "soft_range": [44.0, 56.0],
        "strong_range": [34.0, 66.0],
    },
}

_COUPLING_DEFAULTS = (
    {
        "id": "head_yaw_to_body_yaw",
        "source_axis_id": "head_yaw",
        "target_axis_id": "body_yaw",
        "mode": "same_direction",
        "scale": 0.35,
        "deadzone": 6.0,
        "max_delta": 12.0,
    },
    {
        "id": "head_roll_to_body_roll",
        "source_axis_id": "head_roll",
        "target_axis_id": "body_roll",
        "mode": "same_direction",
        "scale": 0.3,
        "deadzone": 6.0,
        "max_delta": 10.0,
    },
    {
        "id": "gaze_x_to_head_yaw",
        "source_axis_id": "gaze_x",
        "target_axis_id": "head_yaw",
        "mode": "same_direction",
        "scale": 0.25,
        "deadzone": 4.0,
        "max_delta": 10.0,
    },
    {
        "id": "gaze_y_to_head_pitch",
        "source_axis_id": "gaze_y",
        "target_axis_id": "head_pitch",
        "mode": "same_direction",
        "scale": 0.2,
        "deadzone": 4.0,
        "max_delta": 8.0,
    },
)


def build_semantic_axis_profile_path(model_dir: Path) -> Path:
    return model_dir / SEMANTIC_AXIS_PROFILE_DIRNAME / SEMANTIC_AXIS_PROFILE_FILENAME


def build_model_source_hash(model_dir: Path) -> str:
    digest = hashlib.sha256()
    if not model_dir.exists():
        digest.update(b"<missing>")
        return digest.hexdigest()

    for entry in sorted(model_dir.rglob("*")):
        relative_path = entry.relative_to(model_dir).as_posix()
        if relative_path == SEMANTIC_AXIS_PROFILE_DIRNAME or relative_path.startswith(
            f"{SEMANTIC_AXIS_PROFILE_DIRNAME}/"
        ):
            continue

        digest.update(relative_path.encode("utf-8", errors="ignore"))
        if entry.is_dir():
            digest.update(b"<dir>")
            continue
        if not entry.is_file():
            continue

        stat = entry.stat()
        digest.update(str(stat.st_size).encode("utf-8"))
        with entry.open("rb") as handle:
            while True:
                chunk = handle.read(1024 * 1024)
                if not chunk:
                    break
                digest.update(chunk)

    return digest.hexdigest()


def build_default_semantic_axis_profile(
    *,
    model_name: str,
    model_payload: Mapping[str, Any],
    source_hash: str,
) -> SemanticAxisProfile:
    parameter_scan = _as_mapping(model_payload.get("parameter_scan"))
    calibration_profile = _as_mapping(model_payload.get("calibration_profile"))
    calibration_axes = _as_mapping(
        calibration_profile.get("axes") or calibration_profile.get("axis_calibrations")
    )
    standard_channels = _mapping_dict(parameter_scan.get("standard_channels"))
    primary_parameters = {
        str(item.get("channel") or "").strip(): item
        for item in _as_list(parameter_scan.get("primary_parameters"))
        if isinstance(item, Mapping) and str(item.get("channel") or "").strip()
    }
    parameter_names = {
        str(item.get("id") or "").strip(): str(item.get("name") or "").strip()
        for item in _as_list(parameter_scan.get("parameters"))
        if isinstance(item, Mapping) and str(item.get("id") or "").strip()
    }

    axes: list[SemanticAxisDefinition] = []
    for axis_id in _AXIS_ORDER:
        axis_defaults = _AXIS_DEFAULTS[axis_id]
        channel_entry = _as_mapping(standard_channels.get(axis_id))
        calibration_entry = _as_mapping(calibration_axes.get(axis_id))
        candidate_parameter_ids = _collect_candidate_parameter_ids(
            primary_parameters.get(axis_id),
            channel_entry,
            calibration_entry,
        )
        if not candidate_parameter_ids:
            continue

        parameter_bindings = [
            _build_parameter_binding(
                parameter_id=parameter_id,
                parameter_name=parameter_names.get(parameter_id, parameter_id),
                calibration_entry=calibration_entry,
                axis_defaults=axis_defaults,
            )
            for parameter_id in candidate_parameter_ids
        ]

        axes.append(
            {
                "id": axis_id,
                "label": str(axis_defaults["label"]),
                "description": str(axis_defaults["description"]),
                "semantic_group": str(axis_defaults["semantic_group"]),
                "control_role": str(axis_defaults["control_role"]),
                "neutral": 50.0,
                "value_range": [0.0, 100.0],
                "soft_range": [float(value) for value in axis_defaults["soft_range"]],
                "strong_range": [float(value) for value in axis_defaults["strong_range"]],
                "positive_semantics": list(axis_defaults["positive_semantics"]),
                "negative_semantics": list(axis_defaults["negative_semantics"]),
                "usage_notes": str(axis_defaults["usage_notes"]),
                "parameter_bindings": parameter_bindings,
            }
        )

    axis_ids = {axis["id"] for axis in axes}
    if not axes:
        raise SemanticAxisProfileError(
            f"Unable to derive any semantic axes for model `{model_name}` from current scan payload."
        )
    couplings = [
        {
            "id": str(item["id"]),
            "source_axis_id": str(item["source_axis_id"]),
            "target_axis_id": str(item["target_axis_id"]),
            "mode": str(item["mode"]),
            "scale": float(item["scale"]),
            "deadzone": float(item["deadzone"]),
            "max_delta": float(item["max_delta"]),
        }
        for item in _COUPLING_DEFAULTS
        if item["source_axis_id"] in axis_ids and item["target_axis_id"] in axis_ids
    ]

    timestamp = _utc_now_iso()
    return {
        "schema_version": SEMANTIC_AXIS_PROFILE_SCHEMA_VERSION,
        "profile_id": _build_profile_id(model_name),
        "model_id": model_name,
        "source_hash": source_hash,
        "last_scanned_hash": source_hash,
        "revision": 1,
        "status": "generated",
        "user_modified": False,
        "generated_at": timestamp,
        "updated_at": timestamp,
        "axes": axes,
        "couplings": couplings,
    }


def validate_semantic_axis_profile(
    profile_payload: Any,
    *,
    model_name: str,
    known_parameter_ids: set[str] | None = None,
) -> SemanticAxisProfile:
    if not isinstance(profile_payload, Mapping):
        raise SemanticAxisProfileError("SemanticAxisProfile must be a JSON object.")

    schema_version = str(profile_payload.get("schema_version") or "").strip()
    if schema_version != SEMANTIC_AXIS_PROFILE_SCHEMA_VERSION:
        raise SemanticAxisProfileError(
            f"Unsupported semantic axis profile schema_version: {schema_version or '<empty>'}"
        )

    model_id = str(profile_payload.get("model_id") or "").strip()
    if model_id != model_name:
        raise SemanticAxisProfileError(
            f"SemanticAxisProfile model_id mismatch: expected `{model_name}`, got `{model_id or '<empty>'}`."
        )

    profile_id = str(profile_payload.get("profile_id") or "").strip() or _build_profile_id(model_name)
    source_hash = str(profile_payload.get("source_hash") or "").strip()
    if not source_hash:
        raise SemanticAxisProfileError("SemanticAxisProfile source_hash is required.")
    last_scanned_hash = str(profile_payload.get("last_scanned_hash") or "").strip() or source_hash

    revision = _coerce_positive_int(profile_payload.get("revision"), field_name="revision")
    status = str(profile_payload.get("status") or "").strip()
    if status not in {"generated", "user_modified", "stale"}:
        raise SemanticAxisProfileError(
            "SemanticAxisProfile status must be one of `generated`, `user_modified`, or `stale`."
        )
    user_modified = _coerce_bool(
        profile_payload.get("user_modified", status == "user_modified"),
        field_name="user_modified",
    )
    generated_at = str(profile_payload.get("generated_at") or "").strip()
    updated_at = str(profile_payload.get("updated_at") or "").strip()
    if not generated_at:
        raise SemanticAxisProfileError("SemanticAxisProfile generated_at is required.")
    if not updated_at:
        raise SemanticAxisProfileError("SemanticAxisProfile updated_at is required.")

    raw_axes = profile_payload.get("axes")
    if not isinstance(raw_axes, list) or not raw_axes:
        raise SemanticAxisProfileError("SemanticAxisProfile axes must be a non-empty array.")

    normalized_axes: list[SemanticAxisDefinition] = []
    seen_axis_ids: set[str] = set()
    for raw_axis in raw_axes:
        if not isinstance(raw_axis, Mapping):
            raise SemanticAxisProfileError("SemanticAxisProfile axis entries must be objects.")

        axis_id = str(raw_axis.get("id") or "").strip()
        if not axis_id:
            raise SemanticAxisProfileError("SemanticAxisProfile axis id is required.")
        if axis_id in seen_axis_ids:
            raise SemanticAxisProfileError(f"Duplicate semantic axis id: `{axis_id}`.")
        seen_axis_ids.add(axis_id)

        raw_bindings = raw_axis.get("parameter_bindings")
        if not isinstance(raw_bindings, list) or not raw_bindings:
            raise SemanticAxisProfileError(
                f"Semantic axis `{axis_id}` must declare at least one parameter binding."
            )

        normalized_bindings: list[SemanticAxisParameterBinding] = []
        for raw_binding in raw_bindings:
            if not isinstance(raw_binding, Mapping):
                raise SemanticAxisProfileError(
                    f"Semantic axis `{axis_id}` parameter bindings must be objects."
                )

            parameter_id = str(raw_binding.get("parameter_id") or "").strip()
            if not parameter_id:
                raise SemanticAxisProfileError(
                    f"Semantic axis `{axis_id}` contains an empty parameter_id."
                )
            if known_parameter_ids is not None and parameter_id not in known_parameter_ids:
                raise SemanticAxisProfileError(
                    f"Semantic axis `{axis_id}` references unknown parameter_id `{parameter_id}`."
                )

            binding: SemanticAxisParameterBinding = {
                "parameter_id": parameter_id,
                "input_range": _normalize_range(
                    raw_binding.get("input_range"),
                    field_name=f"{axis_id}.parameter_bindings.input_range",
                ),
                "output_range": _normalize_range(
                    raw_binding.get("output_range"),
                    field_name=f"{axis_id}.parameter_bindings.output_range",
                ),
                "default_weight": _coerce_float(
                    raw_binding.get("default_weight", 1.0),
                    field_name=f"{axis_id}.parameter_bindings.default_weight",
                ),
                "invert": bool(raw_binding.get("invert", False)),
            }
            parameter_name = str(raw_binding.get("parameter_name") or "").strip()
            if parameter_name:
                binding["parameter_name"] = parameter_name
            normalized_bindings.append(binding)

        normalized_axes.append(
            {
                "id": axis_id,
                "label": _require_non_empty_string(raw_axis.get("label"), field_name=f"{axis_id}.label"),
                "description": _require_non_empty_string(
                    raw_axis.get("description"),
                    field_name=f"{axis_id}.description",
                ),
                "semantic_group": _require_non_empty_string(
                    raw_axis.get("semantic_group"),
                    field_name=f"{axis_id}.semantic_group",
                ),
                "control_role": _require_allowed_string(
                    raw_axis.get("control_role"),
                    field_name=f"{axis_id}.control_role",
                    allowed_values=ALLOWED_CONTROL_ROLES,
                ),
                "neutral": _coerce_float(raw_axis.get("neutral"), field_name=f"{axis_id}.neutral"),
                "value_range": _normalize_range(raw_axis.get("value_range"), field_name=f"{axis_id}.value_range"),
                "soft_range": _normalize_range(raw_axis.get("soft_range"), field_name=f"{axis_id}.soft_range"),
                "strong_range": _normalize_range(
                    raw_axis.get("strong_range"),
                    field_name=f"{axis_id}.strong_range",
                ),
                "positive_semantics": _normalize_string_list(
                    raw_axis.get("positive_semantics"),
                    field_name=f"{axis_id}.positive_semantics",
                ),
                "negative_semantics": _normalize_string_list(
                    raw_axis.get("negative_semantics"),
                    field_name=f"{axis_id}.negative_semantics",
                ),
                "usage_notes": _require_non_empty_string(
                    raw_axis.get("usage_notes"),
                    field_name=f"{axis_id}.usage_notes",
                ),
                "parameter_bindings": normalized_bindings,
            }
        )

    raw_couplings = profile_payload.get("couplings", [])
    if not isinstance(raw_couplings, list):
        raise SemanticAxisProfileError("SemanticAxisProfile couplings must be an array.")

    normalized_couplings: list[SemanticAxisCoupling] = []
    for raw_coupling in raw_couplings:
        if not isinstance(raw_coupling, Mapping):
            raise SemanticAxisProfileError("SemanticAxisProfile coupling entries must be objects.")
        source_axis_id = _require_non_empty_string(
            raw_coupling.get("source_axis_id"),
            field_name="coupling.source_axis_id",
        )
        target_axis_id = _require_non_empty_string(
            raw_coupling.get("target_axis_id"),
            field_name="coupling.target_axis_id",
        )
        if source_axis_id not in seen_axis_ids or target_axis_id not in seen_axis_ids:
            raise SemanticAxisProfileError(
                f"SemanticAxisProfile coupling `{source_axis_id}->{target_axis_id}` references an unknown axis."
            )
        normalized_couplings.append(
            {
                "id": _require_non_empty_string(raw_coupling.get("id"), field_name="coupling.id"),
                "source_axis_id": source_axis_id,
                "target_axis_id": target_axis_id,
                "mode": _require_allowed_string(
                    raw_coupling.get("mode"),
                    field_name="coupling.mode",
                    allowed_values=ALLOWED_COUPLING_MODES,
                ),
                "scale": _coerce_float(raw_coupling.get("scale"), field_name="coupling.scale"),
                "deadzone": _coerce_float(raw_coupling.get("deadzone"), field_name="coupling.deadzone"),
                "max_delta": _coerce_float(raw_coupling.get("max_delta"), field_name="coupling.max_delta"),
            }
        )

    return {
        "schema_version": SEMANTIC_AXIS_PROFILE_SCHEMA_VERSION,
        "profile_id": profile_id,
        "model_id": model_name,
        "source_hash": source_hash,
        "last_scanned_hash": last_scanned_hash,
        "revision": revision,
        "status": status,
        "user_modified": user_modified,
        "generated_at": generated_at,
        "updated_at": updated_at,
        "axes": normalized_axes,
        "couplings": normalized_couplings,
    }


def load_semantic_axis_profile(
    *,
    model_dir: Path,
    model_name: str,
    known_parameter_ids: set[str] | None = None,
) -> SemanticAxisProfile:
    path = build_semantic_axis_profile_path(model_dir)
    if not path.exists():
        raise FileNotFoundError(f"SemanticAxisProfile file not found: `{path}`.")
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:  # pragma: no cover - covered via validation path after JSON parse.
        raise SemanticAxisProfileError(
            f"Failed to read SemanticAxisProfile from `{path}`: {exc}"
        ) from exc
    return validate_semantic_axis_profile(
        payload,
        model_name=model_name,
        known_parameter_ids=known_parameter_ids,
    )


def ensure_semantic_axis_profile(
    *,
    model_dir: Path,
    model_payload: Mapping[str, Any],
) -> SemanticAxisProfile:
    model_name = str(model_payload.get("name") or "").strip()
    if not model_name:
        raise SemanticAxisProfileError("Model payload is missing `name`, cannot resolve SemanticAxisProfile.")

    known_parameter_ids = collect_known_parameter_ids(model_payload)
    path = build_semantic_axis_profile_path(model_dir)
    current_source_hash = build_model_source_hash(model_dir)
    if path.exists():
        current_profile = load_semantic_axis_profile(
            model_dir=model_dir,
            model_name=model_name,
            known_parameter_ids=known_parameter_ids,
        )
        if str(current_profile["source_hash"]).strip() == current_source_hash:
            if current_profile["status"] == "stale" and not current_profile["user_modified"]:
                refreshed_profile: SemanticAxisProfile = {
                    **current_profile,
                    "status": "generated",
                    "last_scanned_hash": current_source_hash,
                    "updated_at": _utc_now_iso(),
                }
                _write_profile(path, refreshed_profile)
                return refreshed_profile
            return current_profile

        if current_profile["user_modified"]:
            stale_profile: SemanticAxisProfile = {
                **current_profile,
                "status": "stale",
                "last_scanned_hash": current_source_hash,
                "updated_at": _utc_now_iso(),
            }
            _write_profile(path, stale_profile)
            return stale_profile

        profile = build_default_semantic_axis_profile(
            model_name=model_name,
            model_payload=model_payload,
            source_hash=current_source_hash,
        )
        _write_profile(path, profile)
        return profile

    profile = build_default_semantic_axis_profile(
        model_name=model_name,
        model_payload=model_payload,
        source_hash=current_source_hash,
    )
    _write_profile(path, profile)
    return profile


def save_semantic_axis_profile(
    *,
    model_dir: Path,
    model_name: str,
    profile_payload: Any,
    expected_revision: Any,
    known_parameter_ids: set[str] | None = None,
) -> SemanticAxisProfile:
    path = build_semantic_axis_profile_path(model_dir)
    if not path.exists():
        raise FileNotFoundError(
            f"SemanticAxisProfile file not found for `{model_name}` at `{path}`."
        )
    current_source_hash = build_model_source_hash(model_dir)
    current_profile = load_semantic_axis_profile(
        model_dir=model_dir,
        model_name=model_name,
        known_parameter_ids=known_parameter_ids,
    )
    if str(current_profile["source_hash"]).strip() != current_source_hash:
        raise SemanticAxisProfileRevisionError(
            f"SemanticAxisProfile source_hash mismatch for `{model_name}`. "
            "The model files changed, please reload the latest profile before saving."
        )
    current_revision = int(current_profile["revision"])
    normalized_expected_revision = _coerce_positive_int(
        expected_revision,
        field_name="expected_revision",
    )
    if normalized_expected_revision != current_revision:
        raise SemanticAxisProfileRevisionError(
            f"SemanticAxisProfile revision mismatch for `{model_name}`: "
            f"expected_revision={normalized_expected_revision}, current_revision={current_revision}."
        )

    normalized_profile = validate_semantic_axis_profile(
        profile_payload,
        model_name=model_name,
        known_parameter_ids=known_parameter_ids,
    )
    incoming_source_hash = str(normalized_profile["source_hash"]).strip()
    if incoming_source_hash != current_source_hash:
        raise SemanticAxisProfileRevisionError(
            f"SemanticAxisProfile save rejected for `{model_name}` because the incoming "
            f"source_hash does not match the current model hash."
        )
    timestamp = _utc_now_iso()
    current_source_hash = build_model_source_hash(model_dir)
    saved_profile: SemanticAxisProfile = {
        **normalized_profile,
        "schema_version": SEMANTIC_AXIS_PROFILE_SCHEMA_VERSION,
        "profile_id": _build_profile_id(model_name),
        "model_id": model_name,
        "source_hash": current_source_hash,
        "last_scanned_hash": current_source_hash,
        "revision": current_revision + 1,
        "status": "user_modified",
        "user_modified": True,
        "generated_at": str(current_profile.get("generated_at") or normalized_profile["generated_at"]),
        "updated_at": timestamp,
    }
    _write_profile(build_semantic_axis_profile_path(model_dir), saved_profile)
    return saved_profile


def collect_known_parameter_ids(model_payload: Mapping[str, Any]) -> set[str]:
    parameter_scan = _as_mapping(model_payload.get("parameter_scan"))
    result: set[str] = set()
    for item in _as_list(parameter_scan.get("parameters")):
        if not isinstance(item, Mapping):
            continue
        parameter_id = str(item.get("id") or "").strip()
        if parameter_id:
            result.add(parameter_id)
    return result


def _write_profile(path: Path, profile: SemanticAxisProfile) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_suffix(f"{path.suffix}.tmp")
    temp_path.write_text(
        json.dumps(profile, ensure_ascii=False, indent=2, sort_keys=True),
        encoding="utf-8",
    )
    temp_path.replace(path)


def _collect_candidate_parameter_ids(
    primary_parameter: Mapping[str, Any] | None,
    channel_entry: Mapping[str, Any],
    calibration_entry: Mapping[str, Any],
) -> list[str]:
    candidates: list[str] = []
    for source in (
        calibration_entry.get("parameter_ids"),
        calibration_entry.get("preferred_parameter_ids"),
        channel_entry.get("candidate_parameter_ids"),
    ):
        if isinstance(source, list):
            candidates.extend(str(item).strip() for item in source if str(item).strip())

    parameter_id = str(calibration_entry.get("parameter_id") or "").strip()
    if parameter_id:
        candidates.append(parameter_id)

    if isinstance(primary_parameter, Mapping):
        parameter_id = str(primary_parameter.get("parameter_id") or "").strip()
        if parameter_id:
            candidates.append(parameter_id)

    parameter_id = str(channel_entry.get("primary_parameter_id") or "").strip()
    if parameter_id:
        candidates.append(parameter_id)

    deduped: list[str] = []
    seen: set[str] = set()
    for candidate in candidates:
        if candidate in seen:
            continue
        seen.add(candidate)
        deduped.append(candidate)
    return deduped


def _build_parameter_binding(
    *,
    parameter_id: str,
    parameter_name: str,
    calibration_entry: Mapping[str, Any],
    axis_defaults: Mapping[str, Any],
) -> SemanticAxisParameterBinding:
    output_min = calibration_entry.get("output_min")
    output_max = calibration_entry.get("output_max")
    if output_min is None or output_max is None:
        output_min, output_max = axis_defaults["output_range"]

    direction = calibration_entry.get("direction")
    invert = False
    if isinstance(direction, (int, float)):
        invert = float(direction) < 0
    elif isinstance(direction, str):
        invert = direction.strip().lower() in {"-1", "negative", "invert", "reversed"}

    binding: SemanticAxisParameterBinding = {
        "parameter_id": parameter_id,
        "parameter_name": parameter_name or parameter_id,
        "input_range": [
            _coerce_float(calibration_entry.get("value_min", 0.0), field_name="value_min"),
            _coerce_float(calibration_entry.get("value_max", 100.0), field_name="value_max"),
        ],
        "output_range": [
            _coerce_float(output_min, field_name="output_min"),
            _coerce_float(output_max, field_name="output_max"),
        ],
        "default_weight": 1.0,
        "invert": invert,
    }
    return binding


def _build_profile_id(model_name: str) -> str:
    return f"{model_name}.semantic.v1"


def _normalize_range(value: Any, *, field_name: str) -> list[float]:
    if not isinstance(value, list) or len(value) != 2:
        raise SemanticAxisProfileError(f"`{field_name}` must be a two-item numeric array.")
    return [
        _coerce_float(value[0], field_name=field_name),
        _coerce_float(value[1], field_name=field_name),
    ]


def _normalize_string_list(value: Any, *, field_name: str) -> list[str]:
    if not isinstance(value, list):
        raise SemanticAxisProfileError(f"`{field_name}` must be a string array.")
    result = [str(item).strip() for item in value if str(item).strip()]
    if not result:
        raise SemanticAxisProfileError(f"`{field_name}` must contain at least one string.")
    return result


def _require_non_empty_string(value: Any, *, field_name: str) -> str:
    normalized = str(value or "").strip()
    if not normalized:
        raise SemanticAxisProfileError(f"`{field_name}` must be a non-empty string.")
    return normalized


def _coerce_positive_int(value: Any, *, field_name: str) -> int:
    try:
        normalized = int(value)
    except (TypeError, ValueError) as exc:
        raise SemanticAxisProfileError(f"`{field_name}` must be a positive integer.") from exc
    if normalized <= 0:
        raise SemanticAxisProfileError(f"`{field_name}` must be a positive integer.")
    return normalized


def _coerce_float(value: Any, *, field_name: str) -> float:
    try:
        return float(value)
    except (TypeError, ValueError) as exc:
        raise SemanticAxisProfileError(f"`{field_name}` must be numeric.") from exc


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _coerce_bool(value: Any, *, field_name: str) -> bool:
    if isinstance(value, bool):
        return value
    raise SemanticAxisProfileError(f"`{field_name}` must be a boolean.")


def _require_allowed_string(value: Any, *, field_name: str, allowed_values: set[str]) -> str:
    normalized = _require_non_empty_string(value, field_name=field_name)
    if normalized not in allowed_values:
        allowed = ", ".join(sorted(allowed_values))
        raise SemanticAxisProfileError(f"`{field_name}` must be one of: {allowed}.")
    return normalized


def _as_mapping(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def _mapping_dict(value: Any) -> dict[str, Mapping[str, Any]]:
    if not isinstance(value, Mapping):
        return {}
    result: dict[str, Mapping[str, Any]] = {}
    for key, item in value.items():
        key_str = str(key).strip()
        if key_str and isinstance(item, Mapping):
            result[key_str] = item
    return result


def _as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []
