from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class RemoteOperatorRequest:
    computer: str
    profile: str
    prompt: str
