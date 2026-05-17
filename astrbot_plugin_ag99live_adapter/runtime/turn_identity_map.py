from __future__ import annotations


class TurnIdentityMap:
    """Tracks frontend turn ids separately from backend internal turn identities."""

    def __init__(self) -> None:
        self._frontend_to_astrbot: dict[str, str] = {}
        self._astrbot_to_frontend: dict[str, str] = {}

    def register_frontend_turn(self, frontend_turn_id: str) -> str:
        normalized = self._normalize_required(frontend_turn_id, field_name="frontend_turn_id")
        self._frontend_to_astrbot.setdefault(normalized, "")
        return normalized

    def register_bound_turn(
        self,
        *,
        frontend_turn_id: str,
        backend_turn_id: str,
    ) -> str:
        frontend = self.register_frontend_turn(frontend_turn_id)
        self.bind_astrbot_turn(frontend_turn_id=frontend, astrbot_turn_id=backend_turn_id)
        return frontend

    def bind_astrbot_turn(self, *, frontend_turn_id: str, astrbot_turn_id: str) -> None:
        frontend = self._normalize_required(frontend_turn_id, field_name="frontend_turn_id")
        astrbot = self._normalize_required(astrbot_turn_id, field_name="astrbot_turn_id")
        previous_astrbot = self._frontend_to_astrbot.get(frontend)
        if previous_astrbot:
            self._astrbot_to_frontend.pop(previous_astrbot, None)
        previous_frontend = self._astrbot_to_frontend.get(astrbot)
        if previous_frontend and previous_frontend != frontend:
            self._frontend_to_astrbot.pop(previous_frontend, None)
        self._frontend_to_astrbot[frontend] = astrbot
        self._astrbot_to_frontend[astrbot] = frontend

    def resolve_astrbot_turn(self, frontend_turn_id: str | None) -> str | None:
        normalized = self._normalize_optional(frontend_turn_id)
        if not normalized:
            return None
        resolved = self._frontend_to_astrbot.get(normalized)
        return resolved or None

    def resolve_frontend_turn(self, astrbot_turn_id: str | None) -> str | None:
        normalized = self._normalize_optional(astrbot_turn_id)
        if not normalized:
            return None
        return self._astrbot_to_frontend.get(normalized)

    def clear_frontend_turn(self, frontend_turn_id: str | None) -> None:
        normalized = self._normalize_optional(frontend_turn_id)
        if not normalized:
            return
        astrbot_turn_id = self._frontend_to_astrbot.pop(normalized, "")
        if astrbot_turn_id:
            self._astrbot_to_frontend.pop(astrbot_turn_id, None)

    def clear_astrbot_turn(self, astrbot_turn_id: str | None) -> None:
        normalized = self._normalize_optional(astrbot_turn_id)
        if not normalized:
            return
        frontend_turn_id = self._astrbot_to_frontend.pop(normalized, None)
        if frontend_turn_id:
            self._frontend_to_astrbot.pop(frontend_turn_id, None)

    def clear_all(self) -> None:
        self._frontend_to_astrbot.clear()
        self._astrbot_to_frontend.clear()

    @staticmethod
    def _normalize_optional(value: str | None) -> str | None:
        if not isinstance(value, str):
            return None
        normalized = value.strip()
        return normalized or None

    def _normalize_required(self, value: str | None, *, field_name: str) -> str:
        normalized = self._normalize_optional(value)
        if not normalized:
            raise ValueError(f"{field_name} is required.")
        return normalized
