"""AstrBot composition-root helpers.

The platform class remains responsible for supplying host callbacks, while
provider construction and neutral port binding stay inside the AstrBot
adapter boundary.
"""

from __future__ import annotations

from dataclasses import dataclass

from .provider_bridge import (
    AstrBotAvatarOutputPort,
    AstrBotProviderBridge,
    ProviderBridgeCallbacks,
)


@dataclass(frozen=True)
class AstrBotProviderBinding:
    callbacks: ProviderBridgeCallbacks
    avatar_output: AstrBotAvatarOutputPort


def build_provider_bridge(binding: AstrBotProviderBinding) -> AstrBotProviderBridge:
    """Create the complete neutral bridge from host-owned callbacks."""

    return AstrBotProviderBridge.from_callbacks(
        binding.callbacks,
        avatar_output=binding.avatar_output,
    )


__all__ = ["AstrBotProviderBinding", "build_provider_bridge"]
