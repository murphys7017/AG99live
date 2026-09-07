import asyncio
import importlib
import sys
import types


def _install_message_component_stubs(monkeypatch) -> type:
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
    return Plain, Image, Record


def test_output_segments_flush_before_turn_synth_finished(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    install_fake_astrbot()
    Plain, Image, Record = _install_message_component_stubs(monkeypatch)
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

    coordinator = module.OutputSegmentCoordinator(
        runtime_state=types.SimpleNamespace(),
        media_service=MediaService(),
        chat_buffer=ChatBuffer(),
        speaker_name="assistant",
        send_json=send_json,
        performance_curves=PerformanceCurves(),
        observations=Observations(),
        is_turn_terminal=lambda _turn_id: False,
        is_official_inline_anim_compat_enabled=lambda: False,
        finish_turn=finish_turn,
        mark_turn_timing=lambda _turn_id, _key: None,
    )

    async def run_case() -> None:
        await coordinator.emit_message_chain(
            [Record("first.wav", "first")],
            turn_id="turn-1",
            platform_extras={
                "logical_message_id": "segment-1",
                "semantic_text": "first",
                "output_segment": {
                    "turn_id": "turn-1",
                    "message_id": "segment-1",
                    "external_correlation_id": "turn-1",
                    "tts": {
                        "tts_request_id": "tts-1",
                        "status": "succeeded",
                        "failure_code": "",
                        "turn_id": "turn-1",
                        "message_id": "segment-1",
                        "external_correlation_id": "turn-1",
                    },
                },
                "audio_attachment": "present",
            },
        )
        await coordinator.emit_message_chain(
            [Image("first.png")],
            turn_id="turn-1",
            platform_extras={
                "logical_message_id": "segment-1",
                "semantic_text": "first",
            },
        )
        await coordinator.emit_message_chain(
            [Plain("second")],
            turn_id="turn-1",
            platform_extras={"logical_message_id": "segment-2"},
        )
        assert emitted == []
        await coordinator.finalize_output_segment(
            turn_id="turn-1",
            message_id="segment-1",
            flush_reason="logical_delivery_complete",
        )
        assert [envelope["type"] for envelope in emitted] == ["output.segment"]
        assert emitted[0]["payload"]["text"] == {"state": "present", "content": "first"}
        assert emitted[0]["payload"]["audio"]["state"] == "present"
        assert emitted[0]["payload"]["images"] == ["first.png"]
        await coordinator.finalize_output_segment(
            turn_id="turn-1",
            message_id="segment-2",
            flush_reason="logical_delivery_complete",
        )
        await coordinator.emit_message_chain(
            [Plain("first")],
            turn_id="turn-1",
            platform_extras={"logical_message_id": "segment-1"},
        )
        assert [envelope["type"] for envelope in emitted] == [
            "output.segment",
            "output.segment",
        ]
        await coordinator.close_turn_output_queue(turn_id="turn-1")

    asyncio.run(run_case())

    assert [envelope["type"] for envelope in emitted] == [
        "output.segment",
        "output.segment",
        "control.synth_finished",
    ]
    assert [envelope["message_id"] for envelope in emitted[:2]] == [
        "segment-1",
        "segment-2",
    ]
