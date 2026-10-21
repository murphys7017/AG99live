from __future__ import annotations

import asyncio
import importlib
import sys
import types

import pytest


def _install_platform_event_astrbot_stubs(install_fake_astrbot, monkeypatch) -> None:
    install_fake_astrbot()

    event_module = types.ModuleType("astrbot.api.event")

    class AstrMessageEvent:
        def __init__(self, message_str, message_obj, platform_meta, session_id) -> None:
            self.message_str = message_str
            self.message_obj = message_obj
            self.platform_meta = platform_meta
            self.session_id = session_id
            self.unified_msg_origin = "olv_pet_adapter:friend_message:desktop-client"
            self._extras = {}
            self._has_send_oper = False
            self.send_operation_count = 0

        def set_extra(self, key: str, value) -> None:
            self._extras[key] = value

        def get_extra(self, key: str, default=None):
            return self._extras.get(key, default)

        async def send(self, message) -> None:
            del message
            await self._record_send_operation()

        async def _record_send_operation(self) -> None:
            self.send_operation_count += 1
            self._has_send_oper = True

    event_module.AstrMessageEvent = AstrMessageEvent
    monkeypatch.setitem(sys.modules, "astrbot.api.event", event_module)

    message_components_module = types.ModuleType("astrbot.api.message_components")

    class PlainComponent:
        pass

    class ImageComponent:
        pass

    class RecordComponent:
        pass

    message_components_module.Plain = PlainComponent
    message_components_module.Image = ImageComponent
    message_components_module.Record = RecordComponent
    monkeypatch.setitem(
        sys.modules,
        "astrbot.api.message_components",
        message_components_module,
    )

    prompt_module = types.ModuleType("astrbot.core.prompt")
    prompt_module.INPUT_ITEM_ANNOTATIONS_EXTRA_KEY = "prompt_input_item_annotations"
    prompt_module.INPUT_TEXT_ANNOTATION_KEY = "input.text"
    prompt_module.build_message_annotation_key = lambda index: f"message.{index}"
    monkeypatch.setitem(sys.modules, "astrbot.core.prompt", prompt_module)


def _load_platform_event_module():
    module = importlib.import_module("astrbot_plugin_ag99live_adapter.platform_event")
    return importlib.reload(module)


class Plain:
    def __init__(self, text: str = "") -> None:
        self.text = text


class Image:
    def __init__(self, file: str = "image.png") -> None:
        self.file = file


class AdapterStub:
    def __init__(self) -> None:
        self.emit_calls = []
        self.closed_output_queues: list[str] = []
        self.finalized_segments: list[tuple[str, str]] = []
        self.aborted_turns: list[tuple[str, str]] = []
        self.turn_coordinator = types.SimpleNamespace(
            close_turn_output_queue=self._close_turn_output_queue,
            finalize_output_segment=self._finalize_output_segment,
            abort_turn_from_backend=self._abort_turn_from_backend,
        )

    async def emit_message_chain(self, **kwargs) -> None:
        self.emit_calls.append(kwargs)

    async def _close_turn_output_queue(
        self, *, turn_id: str, failure_reason: str | None = None
    ) -> None:
        self.closed_output_queues.append(turn_id)

    async def _finalize_output_segment(self, *, turn_id: str, message_id: str) -> None:
        self.finalized_segments.append((turn_id, message_id))

    async def _abort_turn_from_backend(self, *, turn_id: str, reason: str) -> int:
        self.aborted_turns.append((turn_id, reason))
        return 1


def _build_event(module, *, images: list[dict] | None):
    payload = {"text": "hello"}
    if images is not None:
        payload["images"] = images
    message_obj = type(
        "MessageObjectStub",
        (),
        {
            "message": [Plain("hello"), Image()],
            "raw_message": {"payload": payload},
        },
    )()
    event = module.OLVPetPlatformEvent(
        "hello",
        message_obj,
        {},
        "desktop-client",
        AdapterStub(),
    )
    event.set_extra("output_correlation_id", "turn-1")
    return event


def test_incremental_segments_flush_without_closing_parent_turn(
    install_fake_astrbot, monkeypatch,
) -> None:
    _install_platform_event_astrbot_stubs(install_fake_astrbot, monkeypatch)
    event = _build_event(_load_platform_event_module(), images=[])

    async def run():
        for index, text in enumerate(("first", "second")):
            message_id = f"segment-{index}"
            await event.send_message_with_extras([Plain(text)], platform_extras={
                "logical_message_id": message_id,
                "persona_incremental_delivery": True,
                "persona_delivery_parent_message_id": "parent",
                "persona_segment_index": index, "persona_segment_count": 2,
                "semantic_text": text,
            }, record_send_operation=False)
            await event.flush_visible_segment(message_id=message_id)
            assert event.adapter.finalized_segments == [("turn-1", f"segment-{i}") for i in range(index + 1)]
            assert event.adapter.closed_output_queues == []
        await event.complete_visible_message(message_id="parent")

    asyncio.run(run())
    assert [call["message_chain"][0].text for call in event.adapter.emit_calls] == ["first", "second"]
    assert event.adapter.closed_output_queues == []


def test_streaming_segments_allow_unknown_count_until_terminal_hook(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_platform_event_astrbot_stubs(install_fake_astrbot, monkeypatch)
    event = _build_event(_load_platform_event_module(), images=[])
    event.set_extra("_turn_id", "backend-turn-1")

    async def run() -> None:
        for index, text in enumerate(("first", "second")):
            message_id = f"stream-segment-{index}"
            await event.send_message_with_extras(
                [Plain(text)],
                platform_extras={
                    "logical_message_id": message_id,
                    "persona_incremental_delivery": True,
                    "persona_delivery_parent_message_id": "stream-parent",
                    "persona_result_id": "persona-result-1",
                    "persona_segment_index": index,
                    "persona_streaming": True,
                    "semantic_text": text,
                },
                record_send_operation=False,
            )
            await event.flush_visible_segment(message_id=message_id)

        await event.complete_visible_message(message_id="stream-parent")
        event.mark_persona_stream_finished(
            turn_id="backend-turn-1",
            persona_result_id="persona-result-1",
            message_id="stream-parent",
            segment_count=2,
            status="completed",
        )

    asyncio.run(run())
    assert [
        call["platform_extras"]["persona_segment_index"]
        for call in event.adapter.emit_calls
    ] == [0, 1]
    assert all(
        "persona_segment_count" not in call["platform_extras"]
        for call in event.adapter.emit_calls
    )
    assert set(event.adapter.finalized_segments) == {
        ("turn-1", "stream-segment-0"),
        ("turn-1", "stream-segment-1"),
    }


@pytest.mark.parametrize("speech", ["spoken", ""])
def test_streaming_output_joins_motion_future_by_segment_identity(
    install_fake_astrbot,
    monkeypatch,
    speech,
) -> None:
    _install_platform_event_astrbot_stubs(install_fake_astrbot, monkeypatch)
    event = _build_event(_load_platform_event_module(), images=[])
    event.set_extra("_turn_id", "backend-turn-1")

    async def run() -> None:
        future = asyncio.get_running_loop().create_future()
        future.set_result(
            types.SimpleNamespace(
                motion_payload={"axis_levels": {"Joy": 0.8}},
                reason="independent_provider",
            )
        )
        from astrbot_plugin_ag99live_adapter.runtime.persona_stream_motion import (
            PersonaStreamMotionRegistry,
        )
        registry = PersonaStreamMotionRegistry()
        event.adapter.runtime_state = types.SimpleNamespace(persona_stream_motion=registry)
        registry.register(
            "backend-turn-1",
            {
                "turn_id": "backend-turn-1",
                "persona_result_id": "persona-result-1",
                "parent_message_id": "stream-parent",
                "segment_result_futures": {0: future},
            },
        )
        await event.send_message_with_extras(
            [Plain(speech)],
            platform_extras={
                "logical_message_id": "stream-segment-0",
                "persona_incremental_delivery": True,
                "persona_delivery_parent_message_id": "stream-parent",
                "persona_result_id": "persona-result-1",
                "persona_segment_index": 0,
                "persona_streaming": True,
                "semantic_text": speech,
                "persona_motion_only": not speech,
            },
            record_send_operation=False,
        )

    asyncio.run(run())
    extras = event.adapter.emit_calls[0]["platform_extras"]
    assert extras["client_objects"] == [
        {
            "type": "ag99live.motion_payload",
            "motion_payload": {"axis_levels": {"Joy": 0.8}},
            "mode": "preview",
            "source": "independent_provider",
            "persona_segment_index": 0,
        }
    ]
    assert extras["metadata"]["ag99live_motion_schedule"]["persona_segmented"] is True
    assert event.get_extra(
        "_interaction_persona_stream_motion_downlink_indexes"
    ) == {0}
    assert isinstance(
        event.get_extra("_interaction_personal_stream_first_output_monotonic"),
        float,
    )


def test_streaming_empty_motion_placeholder_is_not_marked_as_downlinked(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_platform_event_astrbot_stubs(install_fake_astrbot, monkeypatch)
    event = _build_event(_load_platform_event_module(), images=[])
    event.set_extra("_turn_id", "backend-turn-1")

    async def run() -> None:
        await event.send_message_with_extras(
            [Plain("")],
            platform_extras={
                "logical_message_id": "stream-segment-0",
                "persona_incremental_delivery": True,
                "persona_delivery_parent_message_id": "stream-parent",
                "persona_result_id": "persona-result-1",
                "persona_segment_index": 0,
                "persona_streaming": True,
                "semantic_text": "",
                "persona_motion_only": True,
            },
            record_send_operation=False,
        )

    asyncio.run(run())
    extras = event.adapter.emit_calls[0]["platform_extras"]
    assert extras["client_objects"] == []
    assert event.get_extra(
        "_interaction_persona_stream_motion_downlink_indexes", set()
    ) == set()
    assert event.get_extra(
        "_interaction_personal_stream_first_output_monotonic"
    ) is None
    assert "persona_segment_count" not in extras


def test_incremental_motion_update_records_first_output_time(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_platform_event_astrbot_stubs(install_fake_astrbot, monkeypatch)
    event = _build_event(_load_platform_event_module(), images=[])
    updates = []

    class WriterStub:
        async def update_motion(self, segment_index, payload):
            updates.append((segment_index, payload))

        async def end_stream(self, resource, segment_index):
            updates.append((resource, segment_index))

    event.set_extra("_interaction_incremental_output_writer", WriterStub())
    event.set_extra("_interaction_incremental_motion_started", {0: True})

    accepted = asyncio.run(
        event.publish_interaction_incremental_motion(
            segment_index=0,
            motion_payload={"actions": ["nod"]},
        )
    )

    assert accepted is True
    assert updates == [
        (0, {"actions": ["nod"]}),
        ("motion", 0),
    ]
    assert isinstance(
        event.get_extra("_interaction_personal_stream_first_output_monotonic"),
        float,
    )


def test_streaming_terminal_rejects_missing_completed_segment(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_platform_event_astrbot_stubs(install_fake_astrbot, monkeypatch)
    event = _build_event(_load_platform_event_module(), images=[])
    event.set_extra("_turn_id", "backend-turn-1")

    async def run() -> None:
        await event.send_message_with_extras(
            [Plain("first")],
            platform_extras={
                "logical_message_id": "stream-segment-0",
                "persona_incremental_delivery": True,
                "persona_delivery_parent_message_id": "stream-parent",
                "persona_result_id": "persona-result-1",
                "persona_segment_index": 0,
                "persona_streaming": True,
                "semantic_text": "first",
            },
            record_send_operation=False,
        )
        event.mark_persona_stream_finished(
            turn_id="backend-turn-1",
            persona_result_id="persona-result-1",
            message_id="stream-parent",
            segment_count=2,
            status="completed",
        )
        with pytest.raises(RuntimeError, match="persona_stream_segment_coverage_incomplete"):
            await event.complete_visible_message(message_id="stream-parent")

    asyncio.run(run())


def test_regular_persona_segment_still_requires_final_count(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_platform_event_astrbot_stubs(install_fake_astrbot, monkeypatch)
    event = _build_event(_load_platform_event_module(), images=[])

    async def run() -> None:
        with pytest.raises(RuntimeError, match="persona_segment_count_invalid"):
            await event.send_message_with_extras(
                [Plain("ordinary")],
                platform_extras={
                    "logical_message_id": "ordinary-segment-0",
                    "persona_incremental_delivery": True,
                    "persona_delivery_parent_message_id": "ordinary-parent",
                    "persona_segment_index": 0,
                    "semantic_text": "ordinary",
                },
                record_send_operation=False,
            )

    asyncio.run(run())


def test_streaming_segments_reject_nonsequential_index(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_platform_event_astrbot_stubs(install_fake_astrbot, monkeypatch)
    event = _build_event(_load_platform_event_module(), images=[])

    async def run() -> None:
        with pytest.raises(
            RuntimeError,
            match="persona_stream_segment_index_nonsequential",
        ):
            await event.send_message_with_extras(
                [Plain("second")],
                platform_extras={
                    "logical_message_id": "stream-segment-1",
                    "persona_incremental_delivery": True,
                    "persona_delivery_parent_message_id": "stream-parent",
                    "persona_result_id": "persona-result-1",
                    "persona_segment_index": 1,
                    "persona_streaming": True,
                    "semantic_text": "second",
                },
                record_send_operation=False,
            )

    asyncio.run(run())


def test_prompt_annotations_skip_desktop_snapshot_without_screen_image(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_platform_event_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = _load_platform_event_module()

    event = _build_event(module, images=[])

    annotations = event.get_extra("prompt_input_item_annotations")
    assert annotations["input.text"]["semantic_type"] == "desktop_chat_turn"
    assert "message.1" not in annotations


def test_persona_segment_stream_request_requires_explicit_compatible_gates(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_platform_event_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = _load_platform_event_module()

    def build_event(*, desktop_stream_enabled=False, **runtime_options):
        adapter = AdapterStub()
        adapter.desktop_persona_segment_stream_enabled = desktop_stream_enabled
        state = {
            "independent_motion_enabled": True,
            "interaction_result_event_filter_available": True,
            "persona_segment_stream_hooks_available": True,
            "independent_motion_provider_id": "motion-provider",
        }
        state.update(runtime_options)
        adapter.runtime_state = types.SimpleNamespace(**state)
        message_obj = type(
            "MessageObjectStub",
            (),
            {"message": [Plain("hello")], "raw_message": {"payload": {"text": "hello"}}},
        )()
        return module.OLVPetPlatformEvent(
            "hello",
            message_obj,
            {},
            "desktop-client",
            adapter,
        )

    default_event = build_event()
    assert default_event.get_extra(
        "_interaction_persona_segment_stream_requested"
    ) is None

    incompatible_event = build_event(
        desktop_stream_enabled=True,
        interaction_result_event_filter_available=False,
    )
    assert incompatible_event.get_extra(
        "_interaction_persona_segment_stream_requested"
    ) is None

    enabled_event = build_event(
        desktop_stream_enabled=True,
    )
    assert enabled_event.get_extra(
        "_interaction_persona_segment_stream_requested"
    ) is True


def test_prompt_annotations_skip_non_screen_image(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_platform_event_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = _load_platform_event_module()

    event = _build_event(
        module,
        images=[
            {
                "data": "base64",
                "mime_type": "image/jpeg",
                "source": "upload",
                "captured_at": "2026-05-24T00:00:00+08:00",
            }
        ],
    )

    annotations = event.get_extra("prompt_input_item_annotations")
    assert annotations["input.text"]["semantic_type"] == "desktop_chat_turn"
    assert "message.1" not in annotations


def test_prompt_annotations_mark_screen_image_as_desktop_snapshot(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_platform_event_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = _load_platform_event_module()

    event = _build_event(
        module,
        images=[
            {
                "data": "base64",
                "mime_type": "image/jpeg",
                "source": "screen",
                "captured_at": "2026-05-24T00:00:00+08:00",
            }
        ],
    )

    annotations = event.get_extra("prompt_input_item_annotations")
    assert annotations["message.1"]["semantic_type"] == "desktop_snapshot"


def test_prompt_annotations_mark_cached_desktop_snapshot(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_platform_event_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = _load_platform_event_module()
    message_obj = type(
        "MessageObjectStub",
        (),
        {
            "message": [Plain("hello"), Image()],
            "raw_message": {
                "payload": {"text": "hello", "images": []},
                "desktop_snapshot_component_indexes": [1],
            },
        },
    )()
    event = module.OLVPetPlatformEvent(
        "hello",
        message_obj,
        {},
        "desktop-client",
        AdapterStub(),
    )

    annotations = event.get_extra("prompt_input_item_annotations")
    assert annotations["message.1"]["semantic_type"] == "desktop_snapshot"


def test_independent_motion_keeps_persona_route(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_platform_event_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = _load_platform_event_module()
    adapter = AdapterStub()
    adapter.runtime_state = types.SimpleNamespace(
        independent_motion_enabled=True,
        independent_motion_provider_id="motion-provider",
    )
    message_obj = type(
        "MessageObjectStub",
        (),
        {"message": [Plain("hello")], "raw_message": {"payload": {"text": "hello"}}},
    )()

    event = module.OLVPetPlatformEvent(
        "hello",
        message_obj,
        {},
        "desktop-client",
        adapter,
    )

    assert event.get_extra("_interaction_core_bypass_requested") is None
    assert event.get_extra("_interaction_plugin_runtime_target_overrides") == {
        "astrbot_plugin_ag99live_adapter": "personal_expression"
    }


def test_send_message_with_extras_only_uses_adapter_emit_path(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_platform_event_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = _load_platform_event_module()
    adapter = AdapterStub()
    message_obj = type(
        "MessageObjectStub",
        (),
        {
            "message": [Plain("hello")],
            "raw_message": {"payload": {"text": "hello"}},
        },
    )()
    event = module.OLVPetPlatformEvent(
        "hello",
        message_obj,
        {},
        "desktop-client",
        adapter,
    )
    event.set_extra("output_correlation_id", "turn-1")
    platform_extras = {"visible_message_id": "msg-1"}

    asyncio.run(
        event.send_message_with_extras(
            [Plain("hi")],
            platform_extras=platform_extras,
            record_send_operation=True,
        )
    )

    assert len(adapter.emit_calls) == 1
    assert adapter.emit_calls[0]["turn_id"] == "turn-1"
    assert adapter.emit_calls[0]["platform_extras"] == {
        "visible_message_id": "msg-1",
        "logical_segment_index": 0,
    }
    assert platform_extras == {"visible_message_id": "msg-1"}
    assert event._has_send_oper is True
    assert event.send_operation_count == 1


def test_standard_send_aggregates_parts_without_closing_output_queue(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_platform_event_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = _load_platform_event_module()
    event = _build_event(module, images=[])
    adapter = event.adapter

    asyncio.run(event.send([Plain("first")]))
    asyncio.run(event.send([Plain("second")]))
    asyncio.run(event.send_message_with_extras([Plain("third")], platform_extras={}))

    assert adapter.closed_output_queues == []
    message_ids = [
        call["platform_extras"]["logical_message_id"]
        for call in adapter.emit_calls
    ]
    assert message_ids == ["direct_output:0001", "direct_output:0002", "standard_reply"]
    assert adapter.finalized_segments == [
        ("turn-1", "direct_output:0001"),
        ("turn-1", "direct_output:0002"),
    ]

    asyncio.run(event.complete_visible_turn())
    assert adapter.closed_output_queues == ["turn-1"]


def test_action_only_visible_turn_waits_for_motion_playback_result(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_platform_event_astrbot_stubs(install_fake_astrbot, monkeypatch)
    event = _build_event(_load_platform_event_module(), images=[])
    event.set_extra("_interaction_wait_for_motion_execution_ack", True)
    received = []

    async def wait_for_turn_finished(*, turn_id: str, timeout_seconds: float):
        received.append((turn_id, timeout_seconds))
        return False, "motion_playback_failed:segment-0"

    event.adapter.turn_coordinator.wait_for_turn_finished = wait_for_turn_finished

    with pytest.raises(RuntimeError, match="motion_playback_failed:segment-0"):
        asyncio.run(event.complete_visible_turn())

    assert event.adapter.closed_output_queues == ["turn-1"]
    assert received == [("turn-1", 30.0)]


def test_persona_tts_gap_keeps_empty_speech_segment_without_motion(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_platform_event_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = _load_platform_event_module()
    event = _build_event(module, images=[])

    asyncio.run(
        event.send_message_with_extras(
            [],
            platform_extras={
                "output_segment": {
                    "message_id": "parent::persona::1",
                    "tts": {"status": "succeeded"},
                },
                "_ag99live_persona_parent_message_id": "parent",
                "persona_segment_index": 1,
                "persona_segment_count": 2,
                "persona_speech_segments": ["", "spoken"],
                "persona_speech_empty_indexes": [0],
            },
            record_send_operation=False,
        )
    )

    assert [
        call["platform_extras"].get("persona_segment_index")
        for call in event.adapter.emit_calls
    ] == [0, 1]
    assert event.adapter.emit_calls[0]["platform_extras"][
        "_ag99live_motion_disabled"
    ] is True
    assert "_ag99live_motion_disabled" not in event.adapter.emit_calls[1][
        "platform_extras"
    ]


def test_failed_persona_tts_segment_uses_bound_segment_identity(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_platform_event_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = _load_platform_event_module()
    event = _build_event(module, images=[])
    event.set_extra(
        "_ag99live_persona_tts_segment_map",
        {
            "tts-segment-1": {
                "parent_message_id": "parent",
                "persona_segment_index": 1,
                "persona_segment_count": 2,
            }
        },
    )

    asyncio.run(
        event.send_message_with_extras(
            [Plain("firstsecond")],
            platform_extras={
                "output_segment": {
                    "turn_id": "turn-1",
                    "message_id": "tts-segment-1",
                    "tts": {"status": "failed", "message_id": "tts-segment-1"},
                },
                "persona_speech_segments": ["first", "second"],
            },
            record_send_operation=False,
        )
    )

    assert [
        call["platform_extras"]["logical_message_id"]
        for call in event.adapter.emit_calls
    ] == ["parent::persona::0000", "tts-segment-1"]
    assert "output_segment" not in event.adapter.emit_calls[0]["platform_extras"]
    assert event.adapter.emit_calls[1]["platform_extras"]["output_segment"][
        "message_id"
    ] == "tts-segment-1"


def test_dual_output_auxiliary_text_uses_bound_persona_parent(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_platform_event_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = _load_platform_event_module()
    event = _build_event(module, images=[])
    event.set_extra(
        "_ag99live_persona_tts_segment_map",
        {
            "parent": {
                "parent_message_id": "parent",
                "persona_segment_index": 0,
                "persona_segment_count": 2,
            }
        },
    )

    asyncio.run(
        event.send_message_with_extras(
            [Plain("rewritten text")],
            platform_extras={
                "logical_message_id": "parent",
                "persona_speech_segments": ["first", "second"],
                "client_objects": [
                    {
                        "type": "ag99live.motion_payload",
                        "motion_payload": {"intent_tags": ["happy"]},
                    }
                ],
            },
            record_send_operation=False,
        )
    )

    assert len(event.adapter.emit_calls) == 1
    extras = event.adapter.emit_calls[0]["platform_extras"]
    assert extras["_ag99live_persona_parent_message_id"] == "parent"
    assert extras["logical_message_id"] == "parent::persona_auxiliary"
    assert extras["client_objects"] == []


def test_abort_visible_turn_routes_to_frontend_turn_coordinator(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_platform_event_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = _load_platform_event_module()
    event = _build_event(module, images=[])

    asyncio.run(event.abort_visible_turn(reason="superseded_by_new_user_input"))

    assert event.adapter.aborted_turns == [
        ("turn-1", "superseded_by_new_user_input")
    ]
