from __future__ import annotations

import asyncio
import importlib
import sys
import types
from types import SimpleNamespace


def test_shadow_motion_uses_primary_prompt_and_never_replaces_primary_result(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    install_fake_astrbot()
    module = importlib.import_module(
        "astrbot_plugin_ag99live_adapter.middleware.interaction_motion.independent"
    )
    requests: list[dict[str, object]] = []
    both_requests_started = asyncio.Event()
    shadow_candidate_recorded = asyncio.Event()
    samples: list[dict[str, object]] = []

    class Provider:
        def __init__(self, name: str) -> None:
            self.name = name

    primary = Provider("deepseek")
    shadow = Provider("spark-v5")
    context = module.IndependentMotionContext(
        current_user_text="请安慰我",
        contexts=({"role": "user", "content": "最近很累"},),
        capability_payload={"axes": []},
        runtime_payload={"recent_executed_motions": []},
        reference_diagnostics=(),
    )
    runtime_state = SimpleNamespace(
        independent_motion_provider_id="deepseek-provider",
        independent_motion_shadow_enabled=True,
        independent_motion_shadow_provider_id="spark-v5-provider",
        independent_motion_shadow_timeout_seconds=5.0,
        selected_independent_motion_shadow_provider=shadow,
        plugin_context=object(),
        motion_lab_recorder=object(),
    )
    bundle = SimpleNamespace(runtime_state=runtime_state)

    class Event:
        message_str = "请安慰我"

        def get_extra(self, key: str, default=None):
            return {
                "_turn_id": "turn-1",
                "_interaction_persona_segment_stream_active": True,
            }.get(key, default)

    async def request_text(provider, **kwargs):
        requests.append({"provider": provider, **kwargs})
        if len(requests) == 2:
            both_requests_started.set()
        await asyncio.wait_for(both_requests_started.wait(), timeout=1)
        return (
            '{"intent_tags":["安慰"],"axis_levels":{"head_pitch":1}}',
            "stream",
        )

    async def recover_json(_text, **_kwargs):
        return {
            "intent_tags": ["安慰"],
            "axis_levels": {"head_pitch": 1},
        }

    def record_sample(_recorder, **kwargs):
        samples.append(kwargs)
        if (
            kwargs["record_stage"] == "motion_candidate"
            and kwargs["motion"].get("candidate_role") == "shadow"
        ):
            shadow_candidate_recorded.set()
        return True

    monkeypatch.setattr(module, "_request_motion_provider_text", request_text)
    monkeypatch.setattr(module, "_build_motion_capability_prompt_payload", lambda value: value)
    monkeypatch.setattr(module, "_build_independent_system_prompt", lambda **_kwargs: "production system prompt")
    monkeypatch.setattr(module, "_build_current_turn_prompt", lambda **_kwargs: "production user prompt")
    monkeypatch.setattr(module, "_motion_guidance_for_prompt", lambda *_args: {})
    monkeypatch.setattr(
        module,
        "normalize_motion_arguments_payload",
        lambda *_args, **_kwargs: (
            {"schema_version": "engine.motion_intent.v4", "axis_levels": {"head_pitch": 1}},
            "ok",
        ),
    )
    monkeypatch.setattr(module, "record_persona_motion_sample", record_sample)
    monkeypatch.setattr(module, "resolve_persona_delivery_mode", lambda _event: "M2_olv_incremental")
    monkeypatch.setattr(module, "resolve_persona_core_turn_id", lambda _event: "core-turn-1")
    astrbot_core = types.ModuleType("astrbot.core")
    astrbot_prompt = types.ModuleType("astrbot.core.prompt")
    json_recovery = types.ModuleType("astrbot.core.prompt.json_recovery")
    json_recovery.recover_json_record = recover_json
    monkeypatch.setitem(sys.modules, "astrbot.core", astrbot_core)
    monkeypatch.setitem(sys.modules, "astrbot.core.prompt", astrbot_prompt)
    monkeypatch.setitem(
        sys.modules,
        "astrbot.core.prompt.json_recovery",
        json_recovery,
    )

    async def run() -> None:
        shadow_tasks: set[asyncio.Task] = set()
        result = await module.generate_independent_motion(
            Event(),
            bundle,
            provider=primary,
            assistant_text="",
            prepared_context=context,
            segment_intent={"actions": [], "tendency": {}},
            persona_result_id="result-1",
            segment_index=0,
            segment_message_id="segment-1",
            shadow_tasks=shadow_tasks,
        )
        await asyncio.wait_for(shadow_candidate_recorded.wait(), timeout=1)
        if shadow_tasks:
            await asyncio.gather(*tuple(shadow_tasks))

        assert result.motion_payload == {
            "schema_version": "engine.motion_intent.v4",
            "axis_levels": {"head_pitch": 1},
        }
        assert len(requests) == 2
        primary_request = next(item for item in requests if item["provider"] is primary)
        shadow_request = next(item for item in requests if item["provider"] is shadow)
        assert primary_request["prompt"] == shadow_request["prompt"]
        assert primary_request["system_prompt"] == shadow_request["system_prompt"]
        assert primary_request["contexts"] == shadow_request["contexts"]
        assert callable(primary_request["on_complete_json"])
        assert shadow_request["on_complete_json"] is None
        assert any(
            item["record_stage"] == "motion_result"
            and item["motion"]["candidate_role"] == "primary"
            and item["motion"]["provider_final"] is True
            for item in samples
        )
        assert any(
            item["record_stage"] == "motion_candidate"
            and item["motion"]["candidate_role"] == "shadow"
            and item["motion"]["provider_final"] is False
            for item in samples
        )

    asyncio.run(run())


def test_motion_dataset_keeps_shadow_output_as_candidate_only() -> None:
    from tools.persona_motion_dataset import _merge_snapshots

    identity = {
        "turn_id": "turn-1",
        "core_turn_id": "core-turn-1",
        "persona_result_id": "result-1",
        "segment_index": 0,
        "segment_count": 1,
        "segment_message_id": "segment-1",
    }
    persona_segment = {
        "speech": "我会陪着你。",
        "speech_state": "ready",
        "actions": [],
        "tendency": {},
    }
    primary_input = {
        "user_text": "请安慰我",
        "recent_context": [],
        "motion_request": {
            "provider_id": "deepseek-provider",
            "candidate_role": "primary",
            "prompt": "same prompt",
        },
    }
    shadow_input = {
        **primary_input,
        "motion_request": {
            "provider_id": "spark-v5-provider",
            "candidate_role": "shadow",
            "prompt": "same prompt",
        },
    }

    def event(event_id, stage, input_context, motion):
        return {
            "id": event_id,
            "created_at": event_id,
            "event_type": "motion.persona_sample.v1",
            "source_route": "independent_motion",
            "raw": {
                "sample_schema": "ag99live.persona_motion_sample.v1",
                "record_stage": stage,
                "identity": identity,
                "delivery": {"mode": "M2_olv_incremental"},
                "input": input_context,
                "persona_segment": persona_segment,
                "motion": motion,
            },
            "phase": stage,
        }

    merged = _merge_snapshots(
        [
            event(
                "1-primary-request",
                "motion_request",
                primary_input,
                {"status": "requested", "candidate_role": "primary"},
            ),
            event(
                "2-shadow-request",
                "motion_request",
                shadow_input,
                {"status": "requested", "candidate_role": "shadow"},
            ),
            event(
                "3-primary-result",
                "motion_result",
                primary_input,
                {
                    "provider_id": "deepseek-provider",
                    "candidate_role": "primary",
                    "provider_final": True,
                    "status": "provider_normalized",
                    "accepted_payload": {"axis_levels": {"head_pitch": 1}},
                },
            ),
            event(
                "4-shadow-candidate",
                "motion_candidate",
                shadow_input,
                {
                    "provider_id": "spark-v5-provider",
                    "candidate_role": "shadow",
                    "provider_final": False,
                    "status": "shadow_provider_normalized",
                    "accepted_payload": {"axis_levels": {"head_pitch": -1}},
                    "raw_output": "shadow raw JSON",
                },
            ),
        ]
    )

    assert merged["collection_status"] == "closed"
    assert merged["final_payload"] == {"axis_levels": {"head_pitch": 1}}
    assert merged["input"]["motion_request"]["provider_id"] == "deepseek-provider"
    assert merged["provider_candidates"] == [
        {
            "provider_update_index": None,
            "provider_id": "spark-v5-provider",
            "candidate_role": "shadow",
            "status": "shadow_provider_normalized",
            "accepted_payload": {"axis_levels": {"head_pitch": -1}},
            "raw_output": "shadow raw JSON",
            "generation_elapsed_ms": None,
            "provider_elapsed_ms": None,
            "provider_started_at_epoch_ms": None,
            "reason": None,
            "provider_final": False,
        }
    ]
