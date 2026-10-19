"""No-chat-turn desktop presence timing contract; no input contents or images."""

import math
from typing import Any

SCHEMA = "ag99live.desktop_presence.v1"
REQUEST_TYPE = "system.desktop_presence_request"
RESULT_TYPE = "system.desktop_presence_result"


def validate_presence_result(payload: dict[str, Any]) -> None:
    if payload.get("schema_version") != SCHEMA:
        raise ValueError("desktop_presence_schema_invalid")
    request_id = payload.get("request_id")
    if not isinstance(request_id, str) or not 1 <= len(request_id) <= 128:
        raise ValueError("desktop_presence_request_id_invalid")
    if type(payload.get("ok")) is not bool:
        raise ValueError("desktop_presence_ok_invalid")
    if not payload["ok"]:
        error = payload.get("error")
        if not isinstance(error, str) or not 1 <= len(error) <= 128:
            raise ValueError("desktop_presence_error_invalid")
        return
    snapshot = payload.get("snapshot")
    if not isinstance(snapshot, dict):
        raise ValueError("desktop_presence_snapshot_invalid")
    boot_id, sequence = snapshot.get("boot_id"), snapshot.get("sequence")
    if (
        not isinstance(boot_id, str)
        or not 1 <= len(boot_id) <= 128
        or type(sequence) is not int
        or not 0 <= sequence <= 9007199254740991
        or not isinstance(snapshot.get("state"), str)
        or snapshot["state"] not in {"active", "inactive", "confirming", "unknown"}
    ):
        raise ValueError("desktop_presence_identity_invalid")
    returned = snapshot.get("returned")
    if returned is None:
        return
    if not isinstance(returned, dict):
        raise ValueError("desktop_presence_return_invalid")
    event_id = returned.get("event_id")
    if (
        not isinstance(event_id, str)
        or not 1 <= len(event_id) <= 128
        or not isinstance(returned.get("basis"), str)
        or returned["basis"] not in {"unlock", "resume", "input_resumed"}
        or sequence == 0
    ):
        raise ValueError("desktop_presence_return_invalid")
    for key in ("inactive_seconds", "age_seconds"):
        value = returned.get(key)
        if (
            isinstance(value, bool)
            or not isinstance(value, int | float)
            or not 0 <= value <= 31536000
            or not math.isfinite(value)
        ):
            raise ValueError(f"desktop_presence_{key}_invalid")
