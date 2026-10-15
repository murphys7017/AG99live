from __future__ import annotations

import asyncio
import importlib
import sys
import types

import pytest


def _install_message_component_stubs(monkeypatch):
    components_module = types.ModuleType("astrbot.api.message_components")

    class Plain:
        def __init__(self, text: str) -> None:
            self.text = text

    class Image:
        def __init__(self, file: str) -> None:
            self.file = file

    class Record:
        def __init__(self, file: str, text: str) -> None:
            self.file = file
            self.text = text

    components_module.Plain = Plain
    components_module.Image = Image
    components_module.Record = Record
    monkeypatch.setitem(sys.modules, "astrbot.api.message_components", components_module)
    return Plain


@pytest.mark.parametrize("motion_reason", ["independent_segment_work_missing", "motion_timeout"])
def test_failed_persona_motion_delivers_audio_and_plain_echo(
    install_fake_astrbot, monkeypatch, motion_reason,
) -> None:
    install_fake_astrbot()
    Plain = _install_message_component_stubs(monkeypatch)
    Record = sys.modules["astrbot.api.message_components"].Record
    importlib.reload(importlib.import_module(
        "astrbot_plugin_ag99live_adapter.runtime.message_utils"
    ))
    module = importlib.import_module(
        "astrbot_plugin_ag99live_adapter.runtime.output_segment_coordinator"
    )
    module = importlib.reload(module)
    emitted = []

    async def send_json(envelope):
        emitted.append(envelope)
        return True

    async def finish_turn(**kwargs):
        pass

    coordinator = module.OutputSegmentCoordinator(
        runtime_state=types.SimpleNamespace(),
        media_service=types.SimpleNamespace(
            cache_audio_file=lambda path: (path, "http://example.test/audio.wav")
        ),
        chat_buffer=types.SimpleNamespace(add=lambda *args: None),
        speaker_name="assistant",
        send_json=send_json,
        performance_curves=types.SimpleNamespace(
            owns_request=lambda **kwargs: False,
            commit_output_side_effects=lambda *args: None,
        ),
        observations=types.SimpleNamespace(
            record_motion_slot=lambda *args, **kwargs: None,
            record_motion_lab_raw_event=lambda **kwargs: None,
            motion_lab_chat_context=lambda: [],
        ),
        is_turn_terminal=lambda turn_id: False,
        finish_turn=finish_turn,
        mark_turn_timing=lambda *args: None,
    )
    extras = {
        "logical_message_id": "segment-1",
        "logical_segment_index": 0,
        "metadata": {
            "ag99live_motion_schedule": {
                "scheduled": False,
                "source": "independent_provider",
                "persona_segmented": True,
                "reason": "motion_payload_missing",
                "motion_resolution_reason": "independent_segment_work_missing",
            }
        },
    }

    if motion_reason == "motion_timeout":
        extras["metadata"]["ag99live_motion_schedule"] = {
            "scheduled": True,
            "source": "independent_provider",
            "persona_segmented": True,
            "persona_motion_failure_reasons": {"0": motion_reason},
        }

    async def run_case():
        await coordinator.emit_message_chain(
            [Record("audio.wav", "服务暂不可用")],
            turn_id="turn-1",
            platform_extras={
                **extras, "persona_segment_index": 0, "persona_segment_count": 1,
            },
        )
        await coordinator.emit_message_chain(
            [Plain("服务暂不可用")], turn_id="turn-1", platform_extras=extras,
        )
        with pytest.raises(ValueError, match="output_segment_persona_count_conflict"):
            await coordinator.emit_message_chain(
                [Plain("服务暂不可用")],
                turn_id="turn-1",
                platform_extras={
                    **extras, "persona_segment_index": 0, "persona_segment_count": 2,
                },
            )
        await coordinator.finalize_output_segment(
            turn_id="turn-1", message_id="segment-1",
        )
        await coordinator.emit_message_chain(
            [Plain("streamed")],
            turn_id="turn-2",
            platform_extras={
                "logical_message_id": "stream-segment-0",
                "logical_segment_index": 0,
                "persona_segment_index": 0,
                "persona_streaming": True,
                "metadata": {
                    "ag99live_motion_schedule": {
                        "scheduled": True,
                        "source": "independent_provider",
                        "persona_segmented": True,
                        "persona_motion_failure_reasons": {"0": "motion_timeout"},
                    }
                },
            },
        )
        await coordinator.finalize_output_segment(
            turn_id="turn-2", message_id="stream-segment-0",
        )

    asyncio.run(run_case())
    assert len(emitted) == 2
    assert emitted[0]["payload"]["text"] == {
        "state": "present", "content": "服务暂不可用",
    }
    assert emitted[0]["payload"]["audio"]["state"] == "present"
    assert emitted[0]["payload"]["motion"] == {
        "state": "failed",
        "reason": f"motion_schedule_failed:{motion_reason}",
    }
    assert emitted[1]["payload"]["text"] == {
        "state": "present", "content": "streamed",
    }
    assert emitted[1]["payload"]["motion"] == {
        "state": "failed",
        "reason": "motion_schedule_failed:motion_timeout",
    }


@pytest.mark.parametrize("segmented_motion", [True, False])
def test_finalized_segments_flush_in_logical_message_order(
    install_fake_astrbot,
    monkeypatch,
    segmented_motion,
) -> None:
    install_fake_astrbot()
    Plain = _install_message_component_stubs(monkeypatch)
    module = importlib.import_module(
        "astrbot_plugin_ag99live_adapter.runtime.output_segment_coordinator"
    )
    module = importlib.reload(module)
    emitted: list[dict] = []

    async def send_json(envelope: dict) -> bool:
        emitted.append(envelope)
        return True

    class MediaService:
        def cache_audio_file(self, path: str) -> tuple[str, str]:
            return path, f"http://example.test/{path}"

    class ChatBuffer:
        def add(self, role: str, text: str) -> None:
            del role, text

    class PerformanceCurves:
        def owns_request(self, **kwargs) -> bool:
            del kwargs
            return False

        def attach_ready_hint(self, *, motion_payload: dict, **kwargs) -> dict:
            del kwargs
            return motion_payload

        def commit_output_side_effects(self, segment, motion_slot: dict) -> None:
            del segment, motion_slot

        def cancel_turn(self, turn_id: str) -> None:
            del turn_id

    class Observations:
        def record_motion_slot(self, motion_slot: dict, *, source: str) -> None:
            del motion_slot, source

        def record_motion_lab_raw_event(self, **kwargs) -> None:
            del kwargs

        def motion_lab_chat_context(self) -> list:
            return []

    async def finish_turn(**kwargs) -> None:
        del kwargs

    def persona_motion_objects() -> list[dict]:
        objects = [
            {
                "type": "ag99live.motion_payload",
                "motion_payload": {
                    "schema_version": "engine.motion_intent.v4",
                    "profile_id": "profile-1",
                    "profile_revision": 1,
                    "model_id": "model-1",
                    "intent_tags": [f"segment_{index}"],
                    "axis_levels": {"head_yaw": index},
                },
                "mode": "preview",
                "source": "independent_provider",
                "persona_segment_index": index,
                "persona_segment_count": 3,
            }
            for index in (1, 2)
        ]
        if not segmented_motion:
            objects = objects[:1]
            objects[0].pop("persona_segment_index")
            objects[0].pop("persona_segment_count")
        return objects

    def persona_schedule() -> dict:
        return {
            "ag99live_motion_schedule": {
                "scheduled": True,
                "source": "independent_provider",
                "persona_segmented": segmented_motion,
                "reason": "independent_provider_segment_motion_payloads",
            }
        }

    coordinator = module.OutputSegmentCoordinator(
        runtime_state=types.SimpleNamespace(),
        media_service=MediaService(),
        chat_buffer=ChatBuffer(),
        speaker_name="assistant",
        send_json=send_json,
        performance_curves=PerformanceCurves(),
        observations=Observations(),
        is_turn_terminal=lambda _turn_id: False,
        finish_turn=finish_turn,
        mark_turn_timing=lambda _turn_id, _key: None,
    )

    async def run_case() -> None:
        await coordinator.emit_message_chain(
            [Plain("")],
            turn_id="turn-1",
            platform_extras={
                "logical_message_id": "segment-0",
                "logical_segment_index": 0,
                "persona_segment_index": 0,
                "persona_segment_count": 3,
                "_ag99live_motion_disabled": True,
                "client_objects": persona_motion_objects(),
                "metadata": persona_schedule(),
            },
        )
        await coordinator.emit_message_chain(
            [Plain("first")],
            turn_id="turn-1",
            platform_extras={
                "logical_message_id": "segment-1",
                "logical_segment_index": 1,
                "persona_segment_index": 1,
                "persona_segment_count": 3,
                "client_objects": persona_motion_objects(),
                "metadata": persona_schedule(),
            },
        )
        await coordinator.emit_message_chain(
            [Plain("second")],
            turn_id="turn-1",
            platform_extras={
                "logical_message_id": "segment-2",
                "logical_segment_index": 2,
                "persona_segment_index": 2,
                "persona_segment_count": 3,
                "client_objects": persona_motion_objects(),
                "metadata": persona_schedule(),
            },
        )
        await coordinator.emit_message_chain(
            [Plain("tagged output")],
            turn_id="turn-1",
            raw_reply_text_override=(
                'tagged output <@anim {"mode":"inline","intent":{}}>'
            ),
            platform_extras={
                "logical_message_id": "segment-3",
                "logical_segment_index": 3,
            },
        )
        await coordinator.finalize_output_segment(
            turn_id="turn-1",
            message_id="segment-2",
        )
        assert emitted == []
        await coordinator.finalize_output_segment(
            turn_id="turn-1",
            message_id="segment-1",
        )
        await coordinator.finalize_output_segment(
            turn_id="turn-1",
            message_id="segment-0",
        )
        await coordinator.finalize_output_segment(
            turn_id="turn-1",
            message_id="segment-3",
        )
        await coordinator.close_turn_output_queue(turn_id="turn-1")

    asyncio.run(run_case())

    assert [envelope["type"] for envelope in emitted] == [
        "output.segment",
        "output.segment",
        "output.segment",
        "output.segment",
        "control.synth_finished",
    ]
    assert [envelope["message_id"] for envelope in emitted[:4]] == [
        "segment-0",
        "segment-1",
        "segment-2",
        "segment-3",
    ]
    assert emitted[0]["payload"]["motion"] == {"state": "absent"}
    assert emitted[1]["payload"]["motion"]["payload"]["intent_tags"] == ["segment_1"]
    if segmented_motion:
        assert emitted[2]["payload"]["motion"]["payload"]["intent_tags"] == ["segment_2"]
    else:
        assert emitted[2]["payload"]["motion"] == {"state": "absent"}
    assert emitted[3]["payload"]["motion"] == {"state": "absent"}
    assert emitted[0]["payload"]["speech"] == {"state": "absent"}
    coordinator._flushed_segment_keys.add("turn-2|segment-1")
    coordinator.clear_turn("turn-1")

    assert coordinator._flushed_segment_keys == {"turn-2|segment-1"}


def test_passive_motion_stream_emits_motion_only_output_segment(
    install_fake_astrbot,
) -> None:
    install_fake_astrbot()
    module = importlib.import_module(
        "astrbot_plugin_ag99live_adapter.runtime.output_segment_coordinator"
    )
    module = importlib.reload(module)
    emitted: list[dict] = []

    async def send_json(envelope: dict) -> bool:
        emitted.append(envelope)
        return True

    class PerformanceCurves:
        def attach_ready_hint(self, *, motion_payload: dict, **kwargs) -> dict:
            del kwargs
            return motion_payload

        def cancel_turn(self, turn_id: str) -> None:
            del turn_id

        def commit_output_side_effects(self, *args, **kwargs) -> None:
            raise AssertionError("passive motion must not enter performance-curve history")

    class Observations:
        def record_motion_slot(self, *args, **kwargs) -> None:
            raise AssertionError("passive motion must not enter regular motion history")

        def record_motion_lab_raw_event(self, **kwargs) -> None:
            raise AssertionError("passive motion must not enter conversation Motion Lab")

    class ChatBuffer:
        def add(self, *args, **kwargs) -> None:
            raise AssertionError("motion-only output must not enter chat history")

    coordinator = module.OutputSegmentCoordinator(
        runtime_state=types.SimpleNamespace(),
        media_service=types.SimpleNamespace(),
        chat_buffer=ChatBuffer(),
        speaker_name="assistant",
        send_json=send_json,
        performance_curves=PerformanceCurves(),
        observations=Observations(),
        is_turn_terminal=lambda _turn_id: False,
        finish_turn=lambda **_kwargs: None,
        mark_turn_timing=lambda *_args: None,
    )

    async def run_case() -> None:
        await coordinator.emit_motion_only(
            turn_id="passive:turn-1",
            message_id="passive_action:1",
            sequence=0,
            motion_payload={
                "schema_version": "engine.motion_intent.v4",
                "profile_id": "profile-1",
                "profile_revision": 1,
                "model_id": "model-1",
                "mode": "expressive",
                "intent_tags": ["gaze_drift"],
                "axis_levels": {"head_yaw": 1},
            },
        )
        await coordinator.close_turn_output_queue(turn_id="passive:turn-1")

    asyncio.run(run_case())

    assert [envelope["type"] for envelope in emitted] == [
        "output.segment",
        "control.synth_finished",
    ]
    payload = emitted[0]["payload"]
    assert payload["sequence"] == 0
    assert payload["text"] == {"state": "absent"}
    assert payload["audio"] == {"state": "absent"}
    assert payload["motion"]["state"] == "present"
    assert payload["motion"]["source"] == "neurobrain_passive_stream"
    assert payload["motion"]["payload"]["intent_tags"] == ["gaze_drift"]
