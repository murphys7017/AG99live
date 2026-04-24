from __future__ import annotations

import asyncio

from astrbot_plugin_ag99live_adapter.motion.realtime_motion_plan import (
    RealtimeMotionPlanGenerator,
    build_plan_from_axes,
    normalize_selector_output,
    resolve_selected_base_action_library,
    resolve_selected_parameter_action_library,
    resolve_selected_model_calibration_profile,
    validate_parameter_plan_payload,
)
from astrbot_plugin_ag99live_adapter.tests.unit.live2d.test_support import build_seed_model_info, build_seed_model_info_with_options


def test_resolve_selected_parameter_action_library_prefers_selected_model() -> None:
    model_info = {
        "selected_model": "Model-B",
        "models": [
            {"name": "Model-A", "parameter_action_library": {"schema_version": "a"}},
            {"name": "Model-B", "parameter_action_library": {"schema_version": "b"}},
        ],
    }
    library = resolve_selected_parameter_action_library(model_info)
    assert isinstance(library, dict)
    assert library["schema_version"] == "b"


def test_resolve_selected_parameter_action_library_does_not_cross_model_fallback() -> None:
    model_info = {
        "selected_model": "Model-B",
        "models": [
            {"name": "Model-A", "parameter_action_library": {"schema_version": "a"}},
            {"name": "Model-B"},
        ],
    }

    library = resolve_selected_parameter_action_library(model_info)
    assert library is None


def test_resolve_selected_base_action_library_prefers_selected_model() -> None:
    model_info = {
        "selected_model": "Model-B",
        "models": [
            {"name": "Model-A", "base_action_library": {"schema_version": "a"}},
            {"name": "Model-B", "base_action_library": {"schema_version": "b"}},
        ],
    }
    library = resolve_selected_base_action_library(model_info)
    assert isinstance(library, dict)
    assert library["schema_version"] == "b"


def test_resolve_selected_base_action_library_does_not_cross_model_fallback() -> None:
    model_info = {
        "selected_model": "Model-B",
        "models": [
            {"name": "Model-A", "base_action_library": {"schema_version": "a"}},
            {"name": "Model-B"},
        ],
    }

    library = resolve_selected_base_action_library(model_info)
    assert library is None


def test_resolve_selected_model_calibration_profile_prefers_selected_model() -> None:
    model_info = {
        "selected_model": "Model-B",
        "models": [
            {
                "name": "Model-A",
                "calibration_profile": {"axes": {"head_yaw": {"invert": True}}},
            },
            {
                "name": "Model-B",
                "calibration_profile": {"axes": {"head_yaw": {"output_max": 72}}},
            },
        ],
    }

    calibration_profile = resolve_selected_model_calibration_profile(model_info)
    assert isinstance(calibration_profile, dict)
    assert calibration_profile["axes"]["head_yaw"]["output_max"] == 72


def test_resolve_selected_model_calibration_profile_accepts_scan_generated_shape() -> None:
    model_info = build_seed_model_info()

    calibration_profile = resolve_selected_model_calibration_profile(model_info)

    assert isinstance(calibration_profile, dict)
    assert calibration_profile["schema_version"] == "direct_parameter_calibration.v1"
    assert calibration_profile["axes"]["head_yaw"]["parameter_id"] == "ParamAngleX"
    assert calibration_profile["axes"]["head_yaw"]["recommended"] is False
    assert calibration_profile["axes"]["head_yaw"]["safe_to_apply"] is False
    assert calibration_profile["axes"]["head_yaw"]["parameter_ids"] == [
        "ParamAngleX",
        "ParamHeadXAlt",
    ]
    assert "recommended_range" not in calibration_profile["axes"]["mouth_open"]


def test_resolve_selected_model_calibration_profile_keeps_safe_scan_generated_axis() -> None:
    model_info = build_seed_model_info_with_options(reinforce_primary_observations=True)

    calibration_profile = resolve_selected_model_calibration_profile(model_info)

    assert isinstance(calibration_profile, dict)
    assert calibration_profile["axes"]["head_yaw"]["recommended"] is True
    assert calibration_profile["axes"]["head_yaw"]["recommended_range"] == {
        "min": -0.05,
        "max": 0.7,
    }


def test_build_plan_from_axes_uses_parameter_action_library_atoms() -> None:
    selector = normalize_selector_output(
        {
            "emotion": "happy",
            "mode": "parallel",
            "axes": {
                "head_yaw": 88,
            },
        }
    )
    library = _build_seed_parameter_action_library()

    plan = build_plan_from_axes(selector, library=library)
    valid, reason = validate_parameter_plan_payload(plan)
    assert valid is True
    assert reason == ""
    assert plan["schema_version"] == "engine.parameter_plan.v1"
    assert plan["mode"] == "expressive"
    assert len(plan["supplementary_params"]) >= 1
    assert plan["supplementary_params"][0]["parameter_id"] == "ParamCheek"
    assert plan["supplementary_params"][0]["channel"] == "head_yaw"


def test_build_plan_from_axes_falls_back_to_base_action_library_atoms() -> None:
    selector = normalize_selector_output(
        {
            "emotion": "happy",
            "mode": "parallel",
            "axes": {
                "head_yaw": 88,
            },
        }
    )
    parameter_library = {
        "schema_version": "parameter_action_library.v1",
        "atoms": [],
    }
    base_action_library = {
        "schema_version": "base_action_library.v1",
        "atoms": [
            {
                "id": "base.head_yaw.positive.01",
                "channel": "head_yaw",
                "polarity": "positive",
                "score": 3.4,
                "energy_score": 2.8,
                "parameter_id": "ParamCheek",
                "strength": "medium",
            },
        ],
    }

    plan = build_plan_from_axes(
        selector,
        library=parameter_library,
        fallback_library=base_action_library,
    )
    valid, reason = validate_parameter_plan_payload(plan)

    assert valid is True
    assert reason == ""
    assert len(plan["supplementary_params"]) >= 1
    assert plan["supplementary_params"][0]["parameter_id"] == "ParamCheek"
    assert plan["supplementary_params"][0]["source_atom_id"] == "base.head_yaw.positive.01"


def test_build_plan_from_axes_without_calibration_profile_keeps_legacy_direct_mapping() -> None:
    selector = normalize_selector_output(
        {
            "emotion": "happy",
            "mode": "parallel",
            "axes": {
                "head_yaw": 88,
            },
        }
    )
    library = _build_calibration_sensitive_parameter_action_library()

    plan = build_plan_from_axes(selector, library=library)

    assert plan["key_axes"]["head_yaw"]["value"] == 88
    assert plan["supplementary_params"][0]["parameter_id"] == "ParamCheek"
    assert plan["supplementary_params"][0]["source_atom_id"] == "head_yaw.positive.cheek"


def test_build_plan_from_axes_applies_calibration_profile_to_axes_and_supplementary() -> None:
    selector = normalize_selector_output(
        {
            "emotion": "happy",
            "mode": "parallel",
            "axes": {
                "head_yaw": 88,
            },
        }
    )
    library = _build_calibration_sensitive_parameter_action_library()
    calibration_profile = {
        "axes": {
            "head_yaw": {
                "direction": -1,
                "output_min": 18,
                "parameter_id": "ParamJaw",
                "recommended_range": {"min": -0.2, "max": 0.4},
                "observed_range": {"min": -0.5, "max": 0.8},
                "supplementary_preferred_parameter_ids": ["ParamJaw"],
                "supplementary_max_atoms": 1,
                "supplementary_target_scale": 0.5,
            }
        }
    }

    plan = build_plan_from_axes(
        selector,
        library=library,
        calibration_profile=calibration_profile,
    )
    valid, reason = validate_parameter_plan_payload(plan)

    assert valid is True
    assert reason == ""
    assert plan["key_axes"]["head_yaw"]["value"] == 18
    assert plan["calibration_profile"] == {
        "schema_version": "",
        "axes": {
            "head_yaw": {
                "parameter_id": "ParamJaw",
                "recommended_range": {"min": -0.2, "max": 0.4},
                "observed_range": {"min": -0.5, "max": 0.8},
            }
        },
    }
    assert plan["supplementary_params"] == []


def test_build_plan_from_axes_skips_low_data_scan_calibration_but_excludes_axis_parameters() -> None:
    selector = normalize_selector_output(
        {
            "emotion": "happy",
            "mode": "parallel",
            "axes": {
                "head_yaw": 88,
            },
        }
    )
    calibration_profile = resolve_selected_model_calibration_profile(build_seed_model_info())
    library = {
        "schema_version": "parameter_action_library.v1",
        "atoms": [
            {
                "id": "head_yaw.positive.axis",
                "primary_channel": "head_yaw",
                "polarity": "positive",
                "score": 5.0,
                "energy_score": 4.0,
                "duration": 0.7,
                "parameter_id": "ParamAngleX",
                "source_motion": "HappyTurn",
                "source_file": "Motions/HappyTurn.motion3.json",
                "source_group": "Idle",
                "semantic_polarity": "positive",
                "trait": "sustain",
                "strength": "medium",
            },
            {
                "id": "head_yaw.positive.cheek",
                "primary_channel": "head_yaw",
                "polarity": "positive",
                "score": 4.0,
                "energy_score": 3.5,
                "duration": 0.6,
                "parameter_id": "ParamCheek",
                "source_motion": "HappyTurn",
                "source_file": "Motions/HappyTurn.motion3.json",
                "source_group": "Idle",
                "semantic_polarity": "positive",
                "trait": "sustain",
                "strength": "medium",
            },
        ],
    }

    plan = build_plan_from_axes(
        selector,
        library=library,
        calibration_profile=calibration_profile,
    )
    valid, reason = validate_parameter_plan_payload(plan)

    assert valid is True
    assert reason == ""
    assert plan["key_axes"]["head_yaw"]["value"] == 88
    assert plan["supplementary_params"] == [
        {
            "parameter_id": "ParamCheek",
            "target_value": 0.5928,
            "weight": 0.72,
            "source_atom_id": "head_yaw.positive.cheek",
            "channel": "head_yaw",
        }
    ]
    assert plan["calibration_profile"]["axes"]["head_yaw"]["safe_to_apply"] is False
    assert "recommended_range" not in plan["calibration_profile"]["axes"]["head_yaw"]


def test_build_plan_from_axes_outputs_idle_mode_when_all_axes_in_deadzone() -> None:
    selector = normalize_selector_output(
        {
            "emotion": "neutral",
            "mode": "parallel",
            "axes": {},
        }
    )
    library = _build_seed_parameter_action_library()

    plan = build_plan_from_axes(selector, library=library)
    valid, reason = validate_parameter_plan_payload(plan)
    assert valid is True
    assert reason == ""
    assert plan["mode"] == "idle"
    assert plan["supplementary_params"] == []


def test_realtime_motion_plan_generator_uses_astrbot_provider() -> None:
    class ProviderStub:
        def __init__(self) -> None:
            self.called = False
            self.last_prompt = ""
            self.last_system_prompt = ""

        async def text_chat(self, *, prompt: str, system_prompt: str):
            self.called = True
            self.last_prompt = prompt
            self.last_system_prompt = system_prompt

            class Response:
                completion_text = (
                    '{"emotion":"curious","mode":"parallel","duration_ms":1200,'
                    '"axes":{"head_yaw":82}}'
                )

            return Response()

    provider = ProviderStub()

    class RuntimeStub:
        enable_realtime_motion_plan = True
        model_info = {
            "selected_model": "Model-A",
            "models": [
                {
                    "name": "Model-A",
                    "parameter_action_library": _build_seed_parameter_action_library(),
                }
            ],
        }
        selected_motion_analysis_provider = provider
        realtime_motion_timeout_seconds = 2.0

    generator = RealtimeMotionPlanGenerator(runtime_state=RuntimeStub())

    plan = asyncio.run(
        generator.generate(
            user_text="what is this?",
            assistant_text="let me explain that for you",
        )
    )
    assert isinstance(plan, dict)
    valid, reason = validate_parameter_plan_payload(plan)
    assert valid is True
    assert reason == ""
    assert plan["mode"] == "expressive"
    assert len(plan.get("supplementary_params", [])) >= 1
    assert provider.called is True
    assert "Given text, choose axis values in [0,100] for an avatar." in provider.last_prompt
    assert "Platform context:" in provider.last_prompt
    assert "Few-shot examples (style reference, do not copy literally):" in provider.last_prompt
    assert "Return strict JSON only." in provider.last_system_prompt


def test_realtime_motion_plan_generator_prompt_switches_off_context_and_few_shot() -> None:
    class ProviderStub:
        def __init__(self) -> None:
            self.last_prompt = ""

        async def text_chat(self, *, prompt: str, system_prompt: str):
            del system_prompt
            self.last_prompt = prompt

            class Response:
                completion_text = (
                    '{"emotion":"neutral","mode":"parallel","duration_ms":1000,'
                    '"axes":{"head_yaw":50}}'
                )

            return Response()

    provider = ProviderStub()

    class RuntimeStub:
        enable_realtime_motion_plan = True
        model_info = {
            "selected_model": "Model-A",
            "models": [
                {
                    "name": "Model-A",
                    "parameter_action_library": _build_seed_parameter_action_library(),
                }
            ],
        }
        selected_motion_analysis_provider = provider
        realtime_motion_timeout_seconds = 2.0
        realtime_motion_fewshot_enabled = False
        realtime_motion_platform_context_enabled = False

    generator = RealtimeMotionPlanGenerator(runtime_state=RuntimeStub())
    plan = asyncio.run(
        generator.generate(
            user_text="好的",
            assistant_text="明白了",
        )
    )

    assert isinstance(plan, dict)
    assert "Few-shot examples (style reference, do not copy literally):" not in provider.last_prompt
    assert "Platform context:" not in provider.last_prompt


def test_build_plan_from_axes_applies_selector_duration_target() -> None:
    selector = normalize_selector_output(
        {
            "emotion": "happy",
            "mode": "parallel",
            "duration_ms": 2400,
            "axes": {
                "head_yaw": 90,
            },
        }
    )
    library = _build_seed_parameter_action_library()

    plan = build_plan_from_axes(selector, library=library)
    assert plan["timing"]["duration_ms"] == 2400
    assert plan["timing"]["blend_in_ms"] > 0
    assert plan["timing"]["hold_ms"] > 0
    assert plan["timing"]["blend_out_ms"] > 0


def test_normalize_selector_output_boosts_subtle_non_neutral_axes() -> None:
    selector = normalize_selector_output(
        {
            "emotion": "playful",
            "mode": "parallel",
            "duration_ms": 1200,
            "axes": {
                "head_roll": 54,
                "head_pitch": 53,
                "mouth_smile": 55,
            },
        }
    )
    assert selector["axes"]["head_roll"] >= 60
    assert selector["axes"]["mouth_smile"] >= 60


def test_normalize_selector_output_keeps_neutral_near_center_axes() -> None:
    selector = normalize_selector_output(
        {
            "emotion": "neutral",
            "mode": "parallel",
            "duration_ms": 1200,
            "axes": {
                "head_roll": 54,
                "head_pitch": 53,
                "mouth_smile": 55,
            },
        }
    )
    assert selector["axes"]["head_roll"] == 54
    assert selector["axes"]["head_pitch"] == 53
    assert selector["axes"]["mouth_smile"] == 55


def test_validate_parameter_plan_payload_rejects_invalid_key_axes() -> None:
    invalid_plan = {
        "schema_version": "engine.parameter_plan.v1",
        "mode": "expressive",
        "emotion_label": "test",
        "timing": {
            "duration_ms": 1200,
            "blend_in_ms": 120,
            "hold_ms": 800,
            "blend_out_ms": 280,
        },
        "key_axes": {
            "head_yaw": {"value": 50},
        },
        "supplementary_params": [],
    }

    valid, reason = validate_parameter_plan_payload(invalid_plan)
    assert valid is False
    assert reason == "key_axes_count_mismatch"


def test_validate_parameter_plan_payload_rejects_missing_supplementary_fields() -> None:
    valid_plan = build_plan_from_axes(
        normalize_selector_output(
            {
                "emotion": "happy",
                "mode": "parallel",
                "axes": {
                    "head_yaw": 88,
                },
            }
        ),
        library=_build_seed_parameter_action_library(),
    )

    broken_plan = {
        **valid_plan,
        "supplementary_params": [
            {
                "parameter_id": "ParamCheek",
                "target_value": 0.4,
                "weight": 0.6,
                "source_atom_id": "",
                "channel": "head_yaw",
            }
        ],
    }
    valid, reason = validate_parameter_plan_payload(broken_plan)
    assert valid is False
    assert reason == "supplementary_source_atom_id_empty"


def _build_seed_parameter_action_library() -> dict:
    return {
        "schema_version": "parameter_action_library.v1",
        "atoms": [
            {
                "id": "head_yaw.positive.01",
                "primary_channel": "head_yaw",
                "polarity": "positive",
                "score": 4.0,
                "energy_score": 5.0,
                "duration": 0.7,
                "parameter_id": "ParamCheek",
                "source_motion": "HappyTurn",
                "source_file": "Motions/HappyTurn.motion3.json",
                "source_group": "Idle",
                "semantic_polarity": "positive",
                "trait": "sustain",
                "strength": "medium",
            },
            {
                "id": "head_yaw.negative.01",
                "primary_channel": "head_yaw",
                "polarity": "negative",
                "score": 3.0,
                "energy_score": 4.0,
                "duration": 0.6,
                "parameter_id": "ParamCheek",
                "source_motion": "SadTurn",
                "source_file": "Motions/SadTurn.motion3.json",
                "source_group": "Idle",
                "semantic_polarity": "negative",
                "trait": "ramp",
                "strength": "medium",
            },
            {
                "id": "mouth_open.positive.01",
                "primary_channel": "mouth_open",
                "polarity": "positive",
                "score": 2.5,
                "energy_score": 2.0,
                "duration": 0.5,
                "parameter_id": "ParamMouthForm",
                "source_motion": "TalkOpen",
                "source_file": "Motions/TalkOpen.motion3.json",
                "source_group": "Talk",
                "semantic_polarity": "positive",
                "trait": "pulse",
                "strength": "low",
            },
        ],
    }


def _build_calibration_sensitive_parameter_action_library() -> dict:
    return {
        "schema_version": "parameter_action_library.v1",
        "atoms": [
            {
                "id": "head_yaw.positive.cheek",
                "primary_channel": "head_yaw",
                "polarity": "positive",
                "score": 5.0,
                "energy_score": 4.0,
                "duration": 0.7,
                "parameter_id": "ParamCheek",
                "source_motion": "HappyTurn",
                "source_file": "Motions/HappyTurn.motion3.json",
                "source_group": "Idle",
                "semantic_polarity": "positive",
                "trait": "sustain",
                "strength": "medium",
            },
            {
                "id": "head_yaw.negative.cheek",
                "primary_channel": "head_yaw",
                "polarity": "negative",
                "score": 4.5,
                "energy_score": 4.5,
                "duration": 0.6,
                "parameter_id": "ParamCheek",
                "source_motion": "SadTurn",
                "source_file": "Motions/SadTurn.motion3.json",
                "source_group": "Idle",
                "semantic_polarity": "negative",
                "trait": "ramp",
                "strength": "medium",
            },
            {
                "id": "head_yaw.negative.jaw",
                "primary_channel": "head_yaw",
                "polarity": "negative",
                "score": 3.5,
                "energy_score": 3.0,
                "duration": 0.6,
                "parameter_id": "ParamJaw",
                "source_motion": "CorrectedTurn",
                "source_file": "Motions/CorrectedTurn.motion3.json",
                "source_group": "Idle",
                "semantic_polarity": "negative",
                "trait": "ramp",
                "strength": "medium",
            },
        ],
    }


