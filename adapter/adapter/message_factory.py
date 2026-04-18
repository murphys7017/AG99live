from __future__ import annotations

import time
from typing import Any, Callable
from uuid import uuid4

from astrbot.api.message_components import Plain
from astrbot.api.platform import AstrBotMessage, MessageMember, MessageType
from astrbot.api import logger

from .client_profile import DEFAULT_CLIENT_NICKNAME, normalize_client_nickname
from .protocol import normalize_inbound_message


class MessageFactory:
    def __init__(
        self,
        *,
        client_uid: str,
        nickname: str = DEFAULT_CLIENT_NICKNAME,
        media_service,
        image_cooldown_seconds_getter: Callable[[], int],
    ) -> None:
        self.client_uid = client_uid
        self.nickname = normalize_client_nickname(nickname)
        self.media_service = media_service
        self._image_cooldown_seconds_getter = image_cooldown_seconds_getter
        self._last_accepted_image_at_monotonic: float | None = None

    def set_client_profile(self, client_uid: str, nickname: str) -> None:
        self.client_uid = client_uid
        self.nickname = normalize_client_nickname(nickname)

    def convert_message(self, data: dict[str, Any]) -> AstrBotMessage:
        inbound = normalize_inbound_message(data, default_session_id=self.client_uid)
        return self.build_message_object(
            text=inbound.payload.text,
            raw_message=inbound.envelope.raw,
            images=inbound.payload.images,
        )

    def build_message_object(
        self,
        *,
        text: str,
        raw_message: dict[str, Any],
        images: list[Any] | None = None,
    ) -> AstrBotMessage:
        images = images or []
        accepted_images, image_diagnostics = self._apply_image_cooldown(images)
        if images:
            logger.info(
                "Inbound desktop message received %s image(s); accepted_after_cooldown=%s text=%s",
                len(images),
                len(accepted_images),
                (text or "")[:80],
            )

        abm = AstrBotMessage()
        abm.type = MessageType.FRIEND_MESSAGE
        abm.self_id = "olv_pet_adapter"
        abm.session_id = self.client_uid
        abm.message_id = str(uuid4())
        abm.message_str = text
        abm.sender = MessageMember(user_id=self.client_uid, nickname=self.nickname)
        abm.message = [Plain(text=text)]
        normalized_raw_message = dict(raw_message)
        resolved_image_inputs: list[dict[str, str]] = []
        failed_image_diagnostics: list[dict[str, Any]] = []

        for image_payload in accepted_images:
            image_component, diagnostic = self.media_service.convert_image_component_with_diagnostic(
                image_payload
            )
            if image_component is not None:
                abm.message.append(image_component)
                image_ref = (
                    (getattr(image_component, "file", "") or "").strip()
                    or (getattr(image_component, "url", "") or "").strip()
                )
                if image_ref:
                    resolved_image_inputs.append(
                        {"type": "input_image", "image_url": image_ref}
                    )
                continue
            if diagnostic:
                failed_image_diagnostics.append(dict(diagnostic))

        if resolved_image_inputs:
            normalized_raw_message["resolved_images"] = resolved_image_inputs
        dropped_image_count = sum(
            1 for item in image_diagnostics if item.get("reason") == "cooldown_window"
        )
        if dropped_image_count > 0:
            normalized_raw_message["dropped_image_count"] = dropped_image_count
        all_image_diagnostics = image_diagnostics + failed_image_diagnostics
        if all_image_diagnostics:
            normalized_raw_message["image_input_diagnostics"] = all_image_diagnostics
        abm.raw_message = normalized_raw_message

        if images:
            logger.info(
                "Inbound desktop image processing finished: received=%s accepted=%s resolved=%s "
                "cooldown_dropped=%s failed=%s",
                len(images),
                len(accepted_images),
                len(resolved_image_inputs),
                dropped_image_count,
                len(failed_image_diagnostics),
            )

        return abm

    def _apply_image_cooldown(self, images: list[Any]) -> tuple[list[Any], list[dict[str, Any]]]:
        if not images:
            return [], []

        image_cooldown_seconds = self._image_cooldown_seconds_getter()
        if image_cooldown_seconds <= 0:
            self._last_accepted_image_at_monotonic = time.monotonic()
            return images, []

        now = time.monotonic()
        last_accepted = self._last_accepted_image_at_monotonic
        if last_accepted is None or (now - last_accepted) >= image_cooldown_seconds:
            self._last_accepted_image_at_monotonic = now
            return images, []

        remaining_seconds = max(int(image_cooldown_seconds - (now - last_accepted)), 0)
        logger.info(
            "Dropped %s image(s) due to cooldown window (%ss remaining approximately).",
            len(images),
            remaining_seconds,
        )
        diagnostics = [
            {"reason": "cooldown_window", "remaining_seconds": str(remaining_seconds)}
            for _ in images
        ]
        return [], diagnostics
