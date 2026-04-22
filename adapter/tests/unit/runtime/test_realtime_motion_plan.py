from __future__ import annotations

import asyncio

from adapter.realtime_motion_plan import (
    RealtimeMotionPlanGenerator,
    build_plan_from_axes,
    normalize_selector_output,
    resolve_selected_parameter_action_library,
)


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
    steps = plan.get("steps")
    assert isinstance(steps, list)
    assert steps
    assert steps[0]["atom_id"] == "head_yaw.positive.01"
    assert steps[0]["channel"] == "head_yaw"


def test_build_plan_from_axes_falls_back_to_best_atom_when_all_axes_neutral() -> None:
    selector = normalize_selector_output(
        {
            "emotion": "neutral",
            "mode": "parallel",
            "axes": {},
        }
    )
    library = _build_seed_parameter_action_library()

    plan = build_plan_from_axes(selector, library=library)
    steps = plan.get("steps")
    assert isinstance(steps, list)
    assert len(steps) == 1
    assert steps[0]["atom_id"] == "head_yaw.positive.01"


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
    assert len(plan.get("steps", [])) >= 1
    assert plan["steps"][0]["atom_id"] == "head_yaw.positive.01"
    assert provider.called is True
    assert "Given text, choose axis values in [0,100] for an avatar." in provider.last_prompt
    assert "Return strict JSON only." in provider.last_system_prompt


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
                "source_motion": "TalkOpen",
                "source_file": "Motions/TalkOpen.motion3.json",
                "source_group": "Talk",
                "semantic_polarity": "positive",
                "trait": "pulse",
                "strength": "low",
            },
        ],
    }
