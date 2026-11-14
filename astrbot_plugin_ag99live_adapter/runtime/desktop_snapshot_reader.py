"""Read the current desktop frame projection from AstrBot Core."""

from __future__ import annotations

from typing import Any

from .desktop_state import (
    DESKTOP_STATE_SNAPSHOT_KIND,
    DESKTOP_STATE_SNAPSHOT_SOURCE,
    DesktopFrameSnapshot,
)


def read_latest_desktop_frame(
    snapshot_hub: Any,
    *,
    platform_id: str,
) -> DesktopFrameSnapshot | None:
    """Resolve one current frame through the Core-owned state and attachment stores."""

    if snapshot_hub is None:
        return None
    from astrbot.api import DesktopStateSnapshot, SnapshotScope

    envelope = snapshot_hub.get_snapshot(
        kind=DESKTOP_STATE_SNAPSHOT_KIND,
        source_id=DESKTOP_STATE_SNAPSHOT_SOURCE,
        scope=SnapshotScope(scope_type="platform", scope_id=str(platform_id)),
    )
    projection = getattr(envelope, "payload", None)
    if not isinstance(projection, DesktopStateSnapshot):
        return None
    frame = projection.latest_frame
    if frame is None:
        return None
    attachment = snapshot_hub.get_attachment(frame.attachment_ref)
    image = getattr(attachment, "payload", None)
    if not isinstance(image, str) or not image:
        return None
    return DesktopFrameSnapshot(
        image=image,
        revision=frame.revision,
        captured_at=frame.captured_at,
        generation=frame.generation,
        client_uid=frame.client_uid,
        attachment_id=frame.attachment_ref.attachment_id,
    )


__all__ = ["read_latest_desktop_frame"]
