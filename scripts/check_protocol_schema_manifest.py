from __future__ import annotations

import json
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
    "model_info": "SCHEMA_MODEL_INFO_V3",
    "motion_intent": "SCHEMA_MOTION_INTENT_V4",
    "motion_tuning_sample": "SCHEMA_MOTION_TUNING_SAMPLE_V2",
    "output_segment": "SCHEMA_OUTPUT_SEGMENT_V4",
    "parameter_action_library": "SCHEMA_PARAMETER_ACTION_LIBRARY_V2",
    "parameter_plan": "SCHEMA_PARAMETER_PLAN_V3",
    "performance_curve_hint": "SCHEMA_PERFORMANCE_CURVE_HINT_V1",
    "semantic_axis_profile": "SCHEMA_SEMANTIC_AXIS_PROFILE_V3",
    "semantic_axis_relation_graph": "SCHEMA_SEMANTIC_AXIS_RELATION_GRAPH_V1",
    "voice_following_profile": "SCHEMA_VOICE_FOLLOWING_PROFILE_V3",
}


def main() -> None:
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    expected = render_typescript(manifest)
    actual = TYPESCRIPT_PATH.read_text(encoding="utf-8")
    if actual != expected:
        raise SystemExit(
            "Generated TypeScript protocol manifest does not match schema_manifest.json."
        )


def render_typescript(manifest: dict) -> str:
    schemas = manifest["schemas"]
    lines = [
        "// Generated from astrbot_plugin_ag99live_adapter/protocol/schema_manifest.json.",
        (
            f'export const PROTOCOL_VERSION = '
            f'{json.dumps(manifest["protocol_version"])} as const;'
        ),
    ]
    lines.extend(
        f"export const {EXPORT_NAMES[key]} = {json.dumps(value)} as const;"
        for key, value in schemas.items()
    )
    lines.extend(["", "export const PROTOCOL_SCHEMAS = {"])
    lines.extend(
        f"  {key}: {EXPORT_NAMES[key]},"
        for key in schemas
    )
    lines.extend(
        [
            "} as const;",
            "",
            "export const PROTOCOL_SCHEMA_MANIFEST = {",
            "  protocol_version: PROTOCOL_VERSION,",
            "  schemas: PROTOCOL_SCHEMAS,",
            "} as const;",
            "",
        ]
    )
    return "\n".join(lines)


if __name__ == "__main__":
    main()
