from __future__ import annotations

from ...core_compatibility import get_interaction_capabilities
from .prompt_builder import (
    _build_motion_capability_prompt_payload,
    _build_motion_decision_contract_text,
    _build_motion_runtime_payload,
    _build_motion_static_capability_payload,
)
from .prompt_context import _record_motion_prompt_reference_observation
from .shared import (
    _resolve_motion_runtime_bundle,
)

class AG99liveMotionPromptContributor:
    plugin_id = "ag99live.motion.prompt"
    priority = 40

    async def collect(self, event, plugin_context, config=None, *, provider_request=None):
        del plugin_context, config, provider_request

        capabilities = get_interaction_capabilities()
        if capabilities is None:
            return None

        bundle = _resolve_motion_runtime_bundle(event)
        if bundle is None:
            return None
        if bool(getattr(bundle.runtime_state, "independent_motion_enabled", False)):
            return None

        static_capability_payload = _build_motion_static_capability_payload(
            bundle.runtime_state
        )
        runtime_payload, reference_diagnostics = _build_motion_runtime_payload(
            event,
            bundle.turn_coordinator,
            bundle.runtime_state,
            capability_payload=static_capability_payload,
        )
        _record_motion_prompt_reference_observation(
            bundle=bundle,
            event=event,
            capability_payload=static_capability_payload,
            runtime_payload=runtime_payload,
            reference_diagnostics=reference_diagnostics,
        )

        extensions = [
            capabilities.prompt_extension(
                plugin_id=self.plugin_id,
                mount="system",
                title="Live2D Motion Decision",
                value_kind="text",
                value=_build_motion_decision_contract_text(static_capability_payload),
                order=39,
                meta={
                    "scope": "static",
                    "node_type": "ag99live_motion_decision_contract",
                    "targets": ["persona"],
                },
            ),
            capabilities.prompt_extension(
                plugin_id=self.plugin_id,
                mount="system",
                title="Live2D Motion Capability",
                value_kind="mapping",
                value=_build_motion_capability_prompt_payload(
                    static_capability_payload
                ),
                order=40,
                meta={
                    "scope": "static",
                    "node_type": "ag99live_motion_capability",
                    "targets": ["persona"],
                },
            ),
        ]
        if runtime_payload:
            extensions.append(
                capabilities.prompt_extension(
                    plugin_id=self.plugin_id,
                    mount="context",
                    title="Live2D Motion Context",
                    value_kind="mapping",
                    value=runtime_payload,
                    order=41,
                    meta={
                        "scope": "dynamic",
                        "node_type": "live2d_previous_motion",
                        "targets": ["persona"],
                    },
                )
            )
        return extensions
