from __future__ import annotations

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

        def set_extra(self, key: str, value) -> None:
            self._extras[key] = value

        def get_extra(self, key: str, default=None):
            return self._extras.get(key, default)

        async def send(self, message) -> None:
            del message
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
    async def emit_message_chain(self, **kwargs) -> None:
        del kwargs


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
