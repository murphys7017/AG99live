from __future__ import annotations

import re
from typing import Any

DEFAULT_CLIENT_UID = "desktop-client"
DEFAULT_CLIENT_NICKNAME = "DesktopUser"


def normalize_client_uid(
    value: Any,
    default: str = DEFAULT_CLIENT_UID,
) -> str:
    if not isinstance(value, str):
        return default

    normalized = re.sub(r"\s+", "-", value.strip())
    return normalized or default


def normalize_client_nickname(
    value: Any,
    default: str = DEFAULT_CLIENT_NICKNAME,
) -> str:
    if not isinstance(value, str):
        return default

    normalized = re.sub(r"\s+", " ", value.strip())
    return normalized or default
