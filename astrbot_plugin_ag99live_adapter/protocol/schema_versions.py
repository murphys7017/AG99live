from __future__ import annotations

import json
from pathlib import Path
from typing import Final


_MANIFEST_PATH = Path(__file__).with_name("schema_manifest.json")
_MANIFEST = json.loads(_MANIFEST_PATH.read_text(encoding="utf-8"))
_SCHEMAS = _MANIFEST["schemas"]

PROTOCOL_VERSION: Final[str] = _MANIFEST["protocol_version"]
CATALOG_MOTION_SCHEMA_VERSION: Final[str] = _SCHEMAS["catalog_motion"]
MOTION_INTENT_V4_SCHEMA_VERSION: Final[str] = _SCHEMAS["motion_intent"]
OUTPUT_SEGMENT_SCHEMA_VERSION: Final[str] = _SCHEMAS["output_segment"]
PARAMETER_PLAN_V2_SCHEMA_VERSION: Final[str] = _SCHEMAS["parameter_plan"]
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
