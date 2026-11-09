from __future__ import annotations

import json
from pathlib import Path
import re


ROOT = Path(__file__).resolve().parents[1]
MANIFEST_PATH = (
    ROOT
    / "astrbot_plugin_ag99live_adapter"
    / "protocol"
    / "schema_manifest.json"
)
TYPESCRIPT_PATH = ROOT / "frontend" / "src" / "types" / "protocolSchema.generated.ts"
CPP_PROTOCOL_PATH = (
    ROOT / "runtime-core" / "include" / "ag99" / "runtime" / "protocol.hpp"
)

EXPORT_NAMES = {
    "pre_action": "PRE_ACTION_SCHEMA_VERSION",
    "audio_input": "AUDIO_INPUT_SCHEMA_VERSION",
    "audio_credit": "AUDIO_CREDIT_SCHEMA_VERSION",
    "protocol_version": "PROTOCOL_VERSION",
    "model_info": "SCHEMA_MODEL_INFO_V4",
    "motion_intent": "SCHEMA_MOTION_INTENT_V4",
    "motion_tuning_sample": "SCHEMA_MOTION_TUNING_SAMPLE_V2",
    "output_segment": "SCHEMA_OUTPUT_SEGMENT_V6",
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
    verify_cpp_constants(manifest)


def verify_cpp_constants(manifest: dict) -> None:
    """Keep the native runtime's hand-written boundary tied to the manifest."""
    actual = CPP_PROTOCOL_PATH.read_text(encoding="utf-8")
    expected_values = {
        "kProtocolVersion": manifest["protocol_version"],
        "kOutputSegmentSchema": manifest["schemas"]["output_segment"],
        "kMotionIntentSchema": manifest["schemas"]["motion_intent"],
        "kParameterPlanSchema": manifest["schemas"]["parameter_plan"],
        "kModelInfoSchema": manifest["schemas"]["model_info"],
    }
    for constant, expected in expected_values.items():
        pattern = rf'{re.escape(constant)}\s*=\s*"([^"]+)"'
        match = re.search(pattern, actual)
        if match is None:
            raise SystemExit(
                f"C++ protocol constant {constant} is missing from {CPP_PROTOCOL_PATH}."
            )
        if match.group(1) != expected:
            raise SystemExit(
                f"C++ protocol constant {constant}={match.group(1)!r} does not "
                f"match schema_manifest.json value {expected!r}."
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
