from __future__ import annotations

import asyncio
import importlib
import sys
import types


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
        self.closed_output_queues = 0
        self.turn_coordinator = types.SimpleNamespace(
            close_turn_output_queue=self._close_turn_output_queue,
        )

    async def emit_message_chain(self, **kwargs) -> None:
        self.emit_calls.append(kwargs)

    async def _close_turn_output_queue(self) -> None:
        self.closed_output_queues += 1


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
    return module.OLVPetPlatformEvent(
        "hello",
        message_obj,
        {},
        "desktop-client",
        AdapterStub(),
    )


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
    platform_extras = {"visible_message_id": "msg-1"}

    asyncio.run(
        event.send_message_with_extras(
            [Plain("hi")],
            platform_extras=platform_extras,
            record_send_operation=True,
        )
    )

    assert len(adapter.emit_calls) == 1
    assert adapter.emit_calls[0]["platform_extras"] == {"visible_message_id": "msg-1"}
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

    assert adapter.closed_output_queues == 0
    assert [
        call["platform_extras"]["logical_message_id"]
        for call in adapter.emit_calls
    ] == ["standard_reply", "standard_reply", "standard_reply"]

    asyncio.run(event.complete_visible_turn())
    assert adapter.closed_output_queues == 1
