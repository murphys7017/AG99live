from __future__ import annotations

import asyncio
import importlib
import json
import sys
from copy import deepcopy
from pathlib import Path

from tests.unit.live2d.test_support import build_seed_model_info


def _import_runtime_state_with_fake_astrbot(
    *,
    install_fake_astrbot,
):
    provider_cls, _ = install_fake_astrbot()
    sys.modules.pop("adapter.runtime_state", None)
    runtime_state = importlib.import_module("adapter.runtime_state")
    return runtime_state, provider_cls


def test_runtime_state_updates_analysis_status_when_provider_succeeds(
    monkeypatch,
    install_fake_astrbot,
) -> None:
    runtime_state, provider_cls = _import_runtime_state_with_fake_astrbot(
        install_fake_astrbot=install_fake_astrbot,
    )

    class ProviderMeta:
        id = "runtime-llm-ok"

    class SuccessfulProvider(provider_cls):
        def meta(self):
            return ProviderMeta()

        async def text_chat(self, *, prompt: str, system_prompt: str):
            del prompt, system_prompt

            class Response:
                completion_text = (
                    '{"selected_atom_ids_by_channel": {"head_yaw": '
                    '["head_yaw.positive.oscillate.01"], "mouth_open": '
                    '["mouth_open.positive.pulse.01"]}}'
                )

            return Response()

    provider = SuccessfulProvider()

    class PluginContext:
        def get_provider_by_id(self, provider_id: str):
            if provider_id == "runtime-llm-ok":
                return provider
            return None

        def get_using_stt_provider(self, umo: str):
            return None

        def get_using_provider(self, umo: str):
            return provider

    seed_model_info = build_seed_model_info()
    monkeypatch.setattr(
        runtime_state,
        "scan_live2d_models",
        lambda **kwargs: deepcopy(seed_model_info),
    )

    state = runtime_state.RuntimeState(
        platform_config={},
        plugin_context=PluginContext(),
        plugin_config={
            "motion_analysis_provider_id": "runtime-llm-ok",
            "action_llm_filter_min_selected_channels": 1,
        },
        plugin_config_loader=None,
        host="127.0.0.1",
        http_port=12397,
        client_uid="desktop-client",
        live2ds_dir=Path("."),
    )
    asyncio.run(state.refresh_async())

    library = state.model_info["models"][0]["base_action_library"]
    assert library["analysis"]["status"] == "filtered"
    assert library["analysis"]["mode"] == "llm_strict"
    assert library["analysis"]["provider_id"] == "runtime-llm-ok"
    assert library["summary"]["selected_atom_count"] == 2
    assert state.selected_motion_analysis_provider is provider


def test_runtime_state_marks_fallback_when_provider_filter_fails(
    monkeypatch,
    install_fake_astrbot,
) -> None:
    runtime_state, provider_cls = _import_runtime_state_with_fake_astrbot(
        install_fake_astrbot=install_fake_astrbot,
    )

    class ProviderMeta:
        id = "runtime-llm-fail"

    class FailingProvider(provider_cls):
        def meta(self):
            return ProviderMeta()

        async def text_chat(self, *, prompt: str, system_prompt: str):
            del prompt, system_prompt
            raise RuntimeError("runtime filter failed")

    provider = FailingProvider()

    class PluginContext:
        def get_provider_by_id(self, provider_id: str):
            if provider_id == "runtime-llm-fail":
                return provider
            return None

        def get_using_stt_provider(self, umo: str):
            return None

        def get_using_provider(self, umo: str):
            return provider

    seed_model_info = build_seed_model_info()
    before_atom_ids = [
        item["id"] for item in seed_model_info["models"][0]["base_action_library"]["atoms"]
    ]
    monkeypatch.setattr(
        runtime_state,
        "scan_live2d_models",
        lambda **kwargs: deepcopy(seed_model_info),
    )

    state = runtime_state.RuntimeState(
        platform_config={},
        plugin_context=PluginContext(),
        plugin_config={
            "motion_analysis_provider_id": "runtime-llm-fail",
            "action_llm_filter_min_selected_channels": 1,
        },
        plugin_config_loader=None,
        host="127.0.0.1",
        http_port=12397,
        client_uid="desktop-client",
        live2ds_dir=Path("."),
    )
    asyncio.run(state.refresh_async())

    library = state.model_info["models"][0]["base_action_library"]
    assert library["analysis"]["status"] == "fallback"
    assert library["analysis"]["mode"] == "rule_seed"
    assert library["analysis"]["provider_id"] == "runtime-llm-fail"
    assert "runtime filter failed" in library["analysis"]["error"]
    assert [item["id"] for item in library["atoms"]] == before_atom_ids


def test_runtime_state_splits_large_payload_into_llm_chunks(
    monkeypatch,
    install_fake_astrbot,
) -> None:
    runtime_state, provider_cls = _import_runtime_state_with_fake_astrbot(
        install_fake_astrbot=install_fake_astrbot,
    )

    class ProviderMeta:
        id = "runtime-llm-chunked"

    class ChunkAwareProvider(provider_cls):
        call_count = 0
        seen_chunk_channels: list[list[str]] = []

        def meta(self):
            return ProviderMeta()

        async def text_chat(self, *, prompt: str, system_prompt: str):
            del system_prompt
            ChunkAwareProvider.call_count += 1

            payload = _extract_json_from_prompt(prompt)
            channels = payload.get("channels", [])
            channel_names = [
                str(item.get("name") or "").strip()
                for item in channels
                if isinstance(item, dict)
            ]
            ChunkAwareProvider.seen_chunk_channels.append(channel_names)

            selected_atom_ids_by_channel: dict[str, list[str]] = {}
            for channel in channels:
                if not isinstance(channel, dict):
                    continue
                channel_name = str(channel.get("name") or "").strip()
                if not channel_name:
                    continue
                candidates = channel.get("candidates") or []
                first_id = ""
                if isinstance(candidates, list) and candidates:
                    first_id = str(candidates[0].get("id") or "").strip()
                selected_atom_ids_by_channel[channel_name] = [first_id] if first_id else []

            class Response:
                completion_text = json.dumps(
                    {
                        "selected_atom_ids_by_channel": selected_atom_ids_by_channel,
                        "reason": "chunk test",
                    },
                    ensure_ascii=False,
                )

            return Response()

    provider = ChunkAwareProvider()

    class PluginContext:
        def get_provider_by_id(self, provider_id: str):
            if provider_id == "runtime-llm-chunked":
                return provider
            return None

        def get_using_stt_provider(self, umo: str):
            return None

        def get_using_provider(self, umo: str):
            return provider

    seed_model_info = build_seed_model_info()
    monkeypatch.setattr(
        runtime_state,
        "scan_live2d_models",
        lambda **kwargs: deepcopy(seed_model_info),
    )

    state = runtime_state.RuntimeState(
        platform_config={},
        plugin_context=PluginContext(),
        plugin_config={
            "motion_analysis_provider_id": "runtime-llm-chunked",
            "action_llm_filter_min_selected_channels": 1,
            "action_llm_filter_chunk_max_channels": 1,
        },
        plugin_config_loader=None,
        host="127.0.0.1",
        http_port=12397,
        client_uid="desktop-client",
        live2ds_dir=Path("."),
    )
    asyncio.run(state.refresh_async())

    library = state.model_info["models"][0]["base_action_library"]
    assert library["analysis"]["status"] == "filtered"
    assert library["analysis"]["mode"] == "llm_strict_chunked"
    assert int(library["analysis"]["chunk_count"]) == 2
    assert library["summary"]["selected_channel_count"] == 2
    assert library["summary"]["selected_atom_count"] == 2
    assert ChunkAwareProvider.call_count == 2
    assert all(len(item) == 1 for item in ChunkAwareProvider.seen_chunk_channels)


def test_runtime_state_reuses_chunked_filter_cache(
    monkeypatch,
    install_fake_astrbot,
) -> None:
    runtime_state, provider_cls = _import_runtime_state_with_fake_astrbot(
        install_fake_astrbot=install_fake_astrbot,
    )

    class ProviderMeta:
        id = "runtime-llm-chunked-cache"

    class ChunkedCacheProvider(provider_cls):
        call_count = 0

        def meta(self):
            return ProviderMeta()

        async def text_chat(self, *, prompt: str, system_prompt: str):
            del system_prompt
            ChunkedCacheProvider.call_count += 1
            payload = _extract_json_from_prompt(prompt)
            selected_atom_ids_by_channel: dict[str, list[str]] = {}
            for channel in payload.get("channels", []):
                if not isinstance(channel, dict):
                    continue
                channel_name = str(channel.get("name") or "").strip()
                candidates = channel.get("candidates") or []
                first_id = ""
                if isinstance(candidates, list) and candidates:
                    first_id = str(candidates[0].get("id") or "").strip()
                selected_atom_ids_by_channel[channel_name] = [first_id] if first_id else []

            class Response:
                completion_text = json.dumps(
                    {"selected_atom_ids_by_channel": selected_atom_ids_by_channel},
                    ensure_ascii=False,
                )

            return Response()

    provider = ChunkedCacheProvider()

    class PluginContext:
        def get_provider_by_id(self, provider_id: str):
            if provider_id == "runtime-llm-chunked-cache":
                return provider
            return None

        def get_using_stt_provider(self, umo: str):
            return None

        def get_using_provider(self, umo: str):
            return provider

    seed_model_info = build_seed_model_info()
    monkeypatch.setattr(
        runtime_state,
        "scan_live2d_models",
        lambda **kwargs: deepcopy(seed_model_info),
    )

    state = runtime_state.RuntimeState(
        platform_config={},
        plugin_context=PluginContext(),
        plugin_config={
            "motion_analysis_provider_id": "runtime-llm-chunked-cache",
            "action_llm_filter_min_selected_channels": 1,
            "action_llm_filter_chunk_max_channels": 1,
        },
        plugin_config_loader=None,
        host="127.0.0.1",
        http_port=12397,
        client_uid="desktop-client",
        live2ds_dir=Path("."),
    )
    asyncio.run(state.refresh_async())
    first_call_count = ChunkedCacheProvider.call_count
    assert first_call_count == 2

    asyncio.run(state.refresh_async())
    library = state.model_info["models"][0]["base_action_library"]
    assert library["analysis"]["status"] == "filtered"
    assert library["analysis"]["cache_hit"] is True
    assert library["analysis"]["mode"] == "llm_strict_chunked_cached"
    assert int(library["analysis"]["chunk_count"]) == 2
    assert ChunkedCacheProvider.call_count == first_call_count


def _extract_json_from_prompt(prompt: str) -> dict:
    text = str(prompt or "").strip()
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1 or end <= start:
        return {}
    return json.loads(text[start : end + 1])
