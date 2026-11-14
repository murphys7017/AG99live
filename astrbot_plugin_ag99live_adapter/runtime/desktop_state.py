"""Connection-scoped desktop input and Core snapshot projection."""

from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
from time import monotonic
from typing import TYPE_CHECKING, Any

from astrbot.api import logger

if TYPE_CHECKING:
    from astrbot.api import (
        DesktopStateSnapshot as CoreDesktopStateSnapshot,
        SnapshotAttachmentRef,
        SnapshotHub,
    )


DESKTOP_STATE_SNAPSHOT_KIND = "desktop_state"
DESKTOP_STATE_SNAPSHOT_SOURCE = "ag99live.desktop"
DESKTOP_FRAME_ATTACHMENT_TTL_SECONDS = 7200.0


@dataclass(frozen=True, slots=True)
class DesktopFrameSnapshot:
    image: str
    revision: int
    captured_at: float
    generation: int
    client_uid: str
    attachment_id: str | None = None

    def remaining_seconds(self, ttl: float) -> float:
        return max(0.0, float(ttl) - (monotonic() - self.captured_at))


@dataclass(frozen=True, slots=True)
class DesktopStateSnapshot:
    state_revision: int
    generation: int
    client_uid: str
    connected: bool
    observation_supported: bool
    presence_supported: bool
    latest_frame: DesktopFrameSnapshot | None
    presence: dict[str, Any] | None


class DesktopStateStore:
    """Capture-side state for one Adapter connection."""

    def __init__(
        self,
        *,
        client_uid: str = "",
        scope_id: str = "",
        snapshot_hub: SnapshotHub | None = None,
    ) -> None:
        self._state_revision = 0
        self._frame_revision = 0
        self._generation = 0
        self._client_uid = str(client_uid or "").strip()
        self._scope_id = str(scope_id or self._client_uid or "default").strip()
        self._snapshot_hub = snapshot_hub
        self._latest_attachment_ref: SnapshotAttachmentRef | None = None
        self._latest_attachment_revision: int | None = None
        self._latest_frame_metadata: tuple[int, float, int, str] | None = None
        self._connected = False
        self._observation_supported = False
        self._presence_supported = False
        self._latest_frame: DesktopFrameSnapshot | None = None
        self._presence: dict[str, Any] | None = None

    @property
    def generation(self) -> int:
        return self._generation

    @property
    def connected(self) -> bool:
        return self._connected

    def mark_connected(self, *, client_uid: str) -> None:
        normalized_uid = str(client_uid or "").strip()
        if self._connected and normalized_uid == self._client_uid:
            return
        self._generation += 1
        self._client_uid = normalized_uid
        self._connected = True
        self._delete_frame_attachment()
        self._observation_supported = False
        self._presence_supported = False
        self._latest_frame = None
        self._latest_frame_metadata = None
        self._presence = None
        self._touch()

    def set_client_uid(self, client_uid: str) -> None:
        normalized_uid = str(client_uid or "").strip()
        if normalized_uid == self._client_uid:
            return
        self._client_uid = normalized_uid
        if self._connected:
            self._generation += 1
            self._delete_frame_attachment()
            self._latest_frame = None
            self._latest_frame_metadata = None
            self._presence = None
        self._touch()

    def update_capabilities(
        self,
        *,
        observation_supported: bool,
        presence_supported: bool,
    ) -> None:
        changed = (
            self._observation_supported != bool(observation_supported)
            or self._presence_supported != bool(presence_supported)
        )
        self._observation_supported = bool(observation_supported)
        self._presence_supported = bool(presence_supported)
        if changed:
            self._touch()

    def update_frame(self, image: str, *, captured_at: float | None = None) -> DesktopFrameSnapshot | None:
        if not self._connected or not isinstance(image, str) or not image:
            return None
        self._frame_revision += 1
        frame = DesktopFrameSnapshot(
            image=image,
            revision=self._frame_revision,
            captured_at=monotonic() if captured_at is None else float(captured_at),
            generation=self._generation,
            client_uid=self._client_uid,
        )
        self._latest_frame = frame
        self._latest_frame_metadata = (
            frame.revision,
            frame.captured_at,
            frame.generation,
            frame.client_uid,
        )
        self._touch()
        if self._snapshot_hub is not None:
            self._latest_frame = None
        return frame

    def update_presence(self, snapshot: dict[str, Any]) -> None:
        if not self._connected:
            return
        self._presence = deepcopy(snapshot)
        self._touch()

    def snapshot(self) -> DesktopStateSnapshot:
        return DesktopStateSnapshot(
            state_revision=self._state_revision,
            generation=self._generation,
            client_uid=self._client_uid,
            connected=self._connected,
            observation_supported=self._observation_supported,
            presence_supported=self._presence_supported,
            latest_frame=self._latest_frame,
            presence=deepcopy(self._presence),
        )

    def disconnect(self) -> None:
        if (
            not self._connected
            and self._latest_frame is None
            and self._latest_frame_metadata is None
            and self._presence is None
        ):
            return
        self._generation += 1
        self._delete_frame_attachment()
        self._connected = False
        self._observation_supported = False
        self._presence_supported = False
        self._latest_frame = None
        self._latest_frame_metadata = None
        self._presence = None
        self._touch()

    def _touch(self) -> None:
        self._state_revision += 1
        if self._snapshot_hub is None:
            return
        try:
            from astrbot.api import SnapshotScope

            if self._latest_frame is not None:
                if (
                    self._latest_attachment_ref is None
                    or self._latest_attachment_revision != self._latest_frame.revision
                ):
                    previous_attachment_ref = self._latest_attachment_ref
                    self._latest_attachment_ref = self._snapshot_hub.put_attachment(
                        kind="desktop_frame",
                        source_id=DESKTOP_STATE_SNAPSHOT_SOURCE,
                        scope=SnapshotScope(
                            scope_type="platform",
                            scope_id=self._scope_id,
                        ),
                        payload=self._latest_frame.image,
                        ttl=DESKTOP_FRAME_ATTACHMENT_TTL_SECONDS,
                        content_type="image/jpeg",
                    )
                    self._latest_attachment_revision = self._latest_frame.revision
                    if previous_attachment_ref is not None:
                        self._snapshot_hub.delete_attachment(previous_attachment_ref)

            self._snapshot_hub.publish_snapshot(
                kind=DESKTOP_STATE_SNAPSHOT_KIND,
                source_id=DESKTOP_STATE_SNAPSHOT_SOURCE,
                scope=SnapshotScope(scope_type="platform", scope_id=self._scope_id),
                payload=self.projection(),
                provenance=("ag99live", "desktop_state_store"),
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("desktop snapshot hub publication failed: %s", exc)

    def projection(self) -> CoreDesktopStateSnapshot:
        from astrbot.api import (
            DesktopFrameReference as CoreDesktopFrameReference,
            DesktopStateSnapshot as CoreDesktopStateSnapshot,
        )

        latest_frame = self._latest_frame
        attachment_ref = self._latest_attachment_ref
        frame_metadata = self._latest_frame_metadata
        if latest_frame is not None:
            frame_metadata = (
                latest_frame.revision,
                latest_frame.captured_at,
                latest_frame.generation,
                latest_frame.client_uid,
            )
        return CoreDesktopStateSnapshot(
            state_revision=self._state_revision,
            generation=self._generation,
            client_uid=self._client_uid,
            connected=self._connected,
            observation_supported=self._observation_supported,
            presence_supported=self._presence_supported,
            latest_frame=(
                CoreDesktopFrameReference(
                    attachment_ref=attachment_ref,
                    revision=frame_metadata[0],
                    captured_at=frame_metadata[1],
                    generation=frame_metadata[2],
                    client_uid=frame_metadata[3],
                )
                if frame_metadata is not None and attachment_ref is not None
                else None
            ),
            presence=deepcopy(self._presence),
        )

    def _delete_frame_attachment(self) -> None:
        if self._snapshot_hub is None or self._latest_attachment_ref is None:
            self._latest_attachment_ref = None
            self._latest_attachment_revision = None
            return
        try:
            self._snapshot_hub.delete_attachment(self._latest_attachment_ref)
        except Exception as exc:  # noqa: BLE001
            logger.warning("desktop frame attachment cleanup failed: %s", exc)
        finally:
            self._latest_attachment_ref = None
            self._latest_attachment_revision = None


__all__ = [
    "DesktopFrameSnapshot",
    "DesktopStateSnapshot",
    "DesktopStateStore",
    "DESKTOP_STATE_SNAPSHOT_KIND",
    "DESKTOP_STATE_SNAPSHOT_SOURCE",
    "DESKTOP_FRAME_ATTACHMENT_TTL_SECONDS",
]
