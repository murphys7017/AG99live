from __future__ import annotations

from collections import deque
from dataclasses import dataclass, asdict


@dataclass
class ChatBufferItem:
    role: str
    text: str


class ChatBuffer:
    def __init__(self, maxlen: int = 10) -> None:
        self._items: deque[ChatBufferItem] = deque(maxlen=maxlen)

    def add(self, role: str, text: str) -> None:
        text = (text or "").strip()
        if not text:
            return
        self._items.append(ChatBufferItem(role=role, text=text))

    def to_list(self) -> list[dict[str, str]]:
        return [asdict(item) for item in self._items]

    def clear(self) -> None:
        self._items.clear()
