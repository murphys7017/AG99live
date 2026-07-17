from __future__ import annotations

import threading
from collections.abc import Iterable
from typing import Any


_registry_lock = threading.RLock()
_online_computer_keys: set[str] = set()


def set_remote_operator_online_computers(computer_keys: Iterable[Any]) -> None:
    next_keys = {_normalize_key(item) for item in computer_keys}
    next_keys.discard("")
    with _registry_lock:
        _online_computer_keys.clear()
        _online_computer_keys.update(next_keys)


def mark_remote_operator_computer_online(computer_key: Any) -> None:
    key = _normalize_key(computer_key)
    if not key:
        return
    with _registry_lock:
        _online_computer_keys.add(key)


def mark_remote_operator_computer_offline(computer_key: Any) -> None:
    key = _normalize_key(computer_key)
    if not key:
        return
    with _registry_lock:
        _online_computer_keys.discard(key)


def get_remote_operator_online_computers() -> set[str]:
    with _registry_lock:
        return set(_online_computer_keys)


def _normalize_key(value: Any) -> str:
    return str(value or "").strip().lower()
