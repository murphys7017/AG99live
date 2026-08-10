from __future__ import annotations

import json
from typing import Any

from .compatibility import PromptExtension
from .prompt_builder import (
    _build_motion_capability_prompt_payload,
    _build_motion_decision_contract_text,
    _build_motion_runtime_payload,
    _build_motion_static_capability_payload,
)
from .prompt_context import (
    _record_motion_prompt_reference_observation,
    _should_contribute_motion_prompt,
)
from .shared import (
    _resolve_motion_runtime_bundle,
)

class AG99liveMotionPromptContributor:
    plugin_id = "ag99live.motion.prompt"
    priority = 40

    async def collect(self, event, plugin_context, view):
        del plugin_context

        bundle = _resolve_motion_runtime_bundle(event)
        if bundle is None:
            return None

        if not _should_contribute_motion_prompt(view):
            return None

        static_capability_payload = _build_motion_static_capability_payload(
            bundle.runtime_state
        )
        runtime_payload, reference_diagnostics = _build_motion_runtime_payload(
            event,
            bundle.turn_coordinator,
            bundle.runtime_state,
            capability_payload=static_capability_payload,
            view=view,
        )
        _record_motion_prompt_reference_observation(
            bundle=bundle,
            event=event,
            capability_payload=static_capability_payload,
            runtime_payload=runtime_payload,
            reference_diagnostics=reference_diagnostics,
        )

        extensions = [
            PromptExtension(
                plugin_id=self.plugin_id,
                mount="system",
                title="Live2D Motion Decision",
                value_kind="text",
                value=_build_motion_decision_contract_text(static_capability_payload),
                order=39,
                meta={
                    "scope": "static",
                    "node_type": "ag99live_motion_decision_contract",
                },
            ),
            PromptExtension(
                plugin_id=self.plugin_id,
                mount="capability",
                title="Live2D Motion Capability",
                value_kind="mapping",
                value=_build_motion_capability_prompt_payload(
                    static_capability_payload
                ),
                order=40,
                meta={
                    "scope": "static",
                    "node_type": "ag99live_motion_capability",
                },
            ),
        ]
        if runtime_payload:
            extensions.append(
                PromptExtension(
                    plugin_id=self.plugin_id,
                    mount="context",
                    title="Live2D Motion Context",
                    value_kind="mapping",
                    value=runtime_payload,
                    order=41,
                    meta={
                        "scope": "dynamic",
                        "node_type": "live2d_previous_motion",
                    },
                )
            )
        return extensions

def append_official_inline_motion_prompt(event: Any, request: Any) -> bool:
    bundle = _resolve_motion_runtime_bundle(event)
    if bundle is None:
        return False

    bundle.runtime_state.ag99live_motion_persona_effect_available = False
    capability_payload = _build_motion_static_capability_payload(bundle.runtime_state)
    runtime_payload, reference_diagnostics = _build_motion_runtime_payload(
        event,
        bundle.turn_coordinator,
        bundle.runtime_state,
        capability_payload=capability_payload,
        view=None,
    )
    _record_motion_prompt_reference_observation(
        bundle=bundle,
        event=event,
        capability_payload=capability_payload,
        runtime_payload=runtime_payload,
        reference_diagnostics=reference_diagnostics,
        source_route="official_inline_anim_compat",
    )

    sections = [
        "Live2D Motion Decision:\n" + _build_motion_decision_contract_text(capability_payload),
        "Live2D Motion Capability:\n"
        + json.dumps(
            _build_motion_capability_prompt_payload(capability_payload),
            ensure_ascii=False,
            separators=(",", ":"),
        ),
    ]
    if runtime_payload:
        sections.append(
            "Live2D Motion Context:\n"
            + json.dumps(runtime_payload, ensure_ascii=False, separators=(",", ":"))
        )
    current_system_prompt = str(getattr(request, "system_prompt", "") or "").rstrip()
    request.system_prompt = "\n\n".join(
        part for part in (current_system_prompt, *sections) if part
    )
    event.set_extra("_ag99live_official_inline_motion_expected", True)
    return True
