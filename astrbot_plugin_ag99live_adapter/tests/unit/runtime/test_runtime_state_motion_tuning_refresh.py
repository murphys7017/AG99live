from __future__ import annotations

import importlib
import sys
from copy import deepcopy

from astrbot_plugin_ag99live_adapter.tests.unit.live2d.test_support import build_seed_model_info


def _import_runtime_state_with_fake_astrbot(
    *,
    install_fake_astrbot,
):
    install_fake_astrbot()
    sys.modules.pop("astrbot_plugin_ag99live_adapter.runtime.state", None)
    return importlib.import_module("astrbot_plugin_ag99live_adapter.runtime.state")


def test_runtime_state_preserves_motion_tuning_examples_across_refresh(
    monkeypatch,
    install_fake_astrbot,
    tmp_path,
) -> None:
    runtime_state = _import_runtime_state_with_fake_astrbot(
        install_fake_astrbot=install_fake_astrbot,
    )
    seed_model_info = build_seed_model_info()
    monkeypatch.setattr(
        runtime_state,
        "scan_live2d_models",
        lambda **kwargs: deepcopy(seed_model_info),
    )
    live2ds_dir = tmp_path / "live2ds"
    (live2ds_dir / "DemoModel").mkdir(parents=True, exist_ok=True)

    state = runtime_state.RuntimeState(
        platform_config={},
        plugin_context=None,
        plugin_config={},
        plugin_config_loader=None,
        host="127.0.0.1",
        http_port=12397,
        client_uid="desktop-client",
        live2ds_dir=live2ds_dir,
    )
    state.set_motion_tuning_reference_examples(
        [
            {
                "input": "Assistant: 好的",
                "output": {
                    "emotion": "joy",
                    "mode": "expressive",
                    "duration_ms": 1600,
                    "axes": {
                        "mouth_smile": 76,
                    },
                },
                "feedback": "嘴角再抬一点",
                "tags": ["smile"],
            }
        ]
    )
    preserved_examples = deepcopy(state.motion_tuning_reference_examples)

    state.refresh()

    assert state.motion_tuning_reference_examples == preserved_examples
