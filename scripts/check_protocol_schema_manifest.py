from __future__ import annotations

import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MANIFEST_PATH = (
    ROOT
    / "astrbot_plugin_ag99live_adapter"
    / "protocol"
    / "schema_manifest.json"
)
TYPESCRIPT_PATH = ROOT / "frontend" / "src" / "types" / "protocolSchema.generated.ts"

EXPORT_NAMES = {
    "protocol_version": "PROTOCOL_VERSION",
    "catalog_motion": "SCHEMA_CATALOG_MOTION_V1",
    "motion_intent": "SCHEMA_MOTION_INTENT_V4",
    "output_segment": "SCHEMA_OUTPUT_SEGMENT_V3",
    "parameter_plan": "SCHEMA_PARAMETER_PLAN_V2",
    "performance_curve_hint": "SCHEMA_PERFORMANCE_CURVE_HINT_V1",
    "semantic_axis_profile": "SCHEMA_SEMANTIC_AXIS_PROFILE_V2",
    "semantic_axis_relation_graph": "SCHEMA_SEMANTIC_AXIS_RELATION_GRAPH_V1",
    "voice_following_profile": "SCHEMA_VOICE_FOLLOWING_PROFILE_V2",
}


def main() -> None:
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    values = {"protocol_version": manifest["protocol_version"], **manifest["schemas"]}
    typescript = TYPESCRIPT_PATH.read_text(encoding="utf-8")
    exported = dict(
        re.findall(
            r'^export const ([A-Z0-9_]+) = "([^"]+)" as const;$',
            typescript,
            flags=re.MULTILINE,
        )
    )
    expected = {EXPORT_NAMES[key]: value for key, value in values.items()}
    if exported != expected:
        raise SystemExit(
            "Generated TypeScript protocol constants do not match schema_manifest.json."
        )


if __name__ == "__main__":
    main()
