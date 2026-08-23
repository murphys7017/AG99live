from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Final


_MANIFEST_PATH = Path(__file__).with_name("schema_manifest.json")
_MANIFEST = json.loads(_MANIFEST_PATH.read_text(encoding="utf-8"))
_SCHEMAS = _MANIFEST["schemas"]

SCHEMA_MANIFEST: Final[dict[str, Any]] = _MANIFEST
PROTOCOL_VERSION: Final[str] = _MANIFEST["protocol_version"]
MODEL_INFO_SCHEMA_VERSION: Final[str] = _SCHEMAS["model_info"]
MOTION_INTENT_V4_SCHEMA_VERSION: Final[str] = _SCHEMAS["motion_intent"]
MOTION_TUNING_SAMPLE_SCHEMA_VERSION: Final[str] = _SCHEMAS["motion_tuning_sample"]
OUTPUT_SEGMENT_SCHEMA_VERSION: Final[str] = _SCHEMAS["output_segment"]
PARAMETER_ACTION_LIBRARY_SCHEMA_VERSION: Final[str] = _SCHEMAS[
    "parameter_action_library"
]
PARAMETER_PLAN_V3_SCHEMA_VERSION: Final[str] = _SCHEMAS["parameter_plan"]
PERFORMANCE_CURVE_HINT_SCHEMA_VERSION: Final[str] = _SCHEMAS[
    "performance_curve_hint"
]
SEMANTIC_AXIS_PROFILE_SCHEMA_VERSION: Final[str] = _SCHEMAS[
    "semantic_axis_profile"
]
SEMANTIC_AXIS_RELATION_GRAPH_SCHEMA_VERSION: Final[str] = _SCHEMAS[
    "semantic_axis_relation_graph"
]
VOICE_FOLLOWING_PROFILE_SCHEMA_VERSION: Final[str] = _SCHEMAS[
    "voice_following_profile"
]
