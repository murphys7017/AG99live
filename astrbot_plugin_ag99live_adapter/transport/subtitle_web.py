"""Read-only OBS subtitle projection, separate from the desktop transport."""

from __future__ import annotations

import asyncio
import hashlib
import json
import secrets
from pathlib import Path
from time import monotonic
from typing import TYPE_CHECKING, Any

from aiohttp import web

from astrbot.api import logger

from ..protocol.subtitle import validate_subtitle_state

if TYPE_CHECKING:
    from collections.abc import Callable

    from astrbot.api import SnapshotHub, SnapshotScope

MAX_CSS_BYTES = 64 * 1024
READING_KIND = "ag99live_reading"
READING_SOURCE = "ag99live.stream_host"
RENDERED_KIND = "ag99live_reading_rendered"
RENDERED_SOURCE = "ag99live.subtitle"
RENDER_RECEIPT_TTL_SECONDS = 10


class SubtitleWebService:
    """Project actual playback facts; OBS never owns playback acknowledgements."""

    def __init__(
        self, *, port: int, assets_dir: Path, css_path: Path, speaker: str,
        snapshot_hub: SnapshotHub | None = None,
        reading_scope: SnapshotScope | None = None,
        reading_target: Callable[[], str] | None = None,
    ):
        if not 1 <= port <= 65535:
            raise ValueError("subtitle_port_invalid")
        self.port = port
        self.assets_dir = assets_dir
        self.css_path = css_path
        self.speaker = speaker
        self._runner: web.AppRunner | None = None
        self._watch_task: asyncio.Task | None = None
        self._subscribers: set[asyncio.Queue] = set()
        self._source_sequence = 0
        self._revision = 0
        self._css = ""
        self._css_revision = 0
        self._css_lock = asyncio.Lock()
        self._caption = self._empty_caption()
        self._hub = snapshot_hub
        self._reading_scope = reading_scope
        self._reading_target = reading_target
        self._reading_subscription = None
        self._reading_views: dict[str, tuple[str, asyncio.Queue]] = {}
        self._rendered_view: tuple[str, asyncio.Queue] | None = None
        self._rendered_identity: tuple | None = None
        self._rendered_at = 0.0
        self._last_rendered_heartbeat = 0.0

    def _empty_caption(self) -> dict[str, Any]:
        return {"state": "idle", "text": "", "turn_id": None,
                "segment_id": "", "speaker": self.speaker}

    def snapshot(self) -> dict[str, Any]:
        return {"revision": self._revision, "css_revision": self._css_revision,
                "caption": dict(self._caption)}

    async def start(self) -> None:
        if self._runner is not None:
            return
        await asyncio.to_thread(self.css_path.parent.mkdir, parents=True, exist_ok=True)
        if not self.css_path.exists():
            await asyncio.to_thread(self.css_path.write_text, "/* Custom OBS subtitle CSS. */\n", encoding="utf-8")
        await self._reload_css()
        @web.middleware
        async def local_host_only(request: web.Request, handler):
            if request.host.lower() not in {f"127.0.0.1:{self.port}", f"localhost:{self.port}"}:
                raise web.HTTPForbidden(text="Use the local subtitle URL.")
            return await handler(request)

        app = web.Application(client_max_size=MAX_CSS_BYTES, middlewares=[local_host_only])
        app.router.add_get("/subtitle", self._redirect)
        app.router.add_get("/subtitle/", self._page)
        app.router.add_get("/subtitle/editor", self._editor)
        app.router.add_get("/subtitle/events", self._events)
        app.router.add_post("/subtitle/reading/rendered", self._acknowledge_reading)
        app.router.add_get("/subtitle/custom.css", self._custom_css)
        app.router.add_get("/subtitle/config", self._config)
        app.router.add_put("/subtitle/custom.css", self._save_css)
        app.router.add_static("/subtitle/assets/", self.assets_dir)
        app.on_shutdown.append(self._shutdown_subscribers)
        runner = web.AppRunner(app, access_log=None, shutdown_timeout=2)
        await runner.setup()
        try:
            await web.TCPSite(runner, "127.0.0.1", self.port).start()
        except BaseException:
            await runner.cleanup()
            raise
        self._runner = runner
        if self._hub is not None and self._reading_scope is not None:
            self._clear_reading_receipt()
            self._reading_subscription = self._hub.subscribe(
                kind=READING_KIND, source_id=READING_SOURCE, scope=self._reading_scope,
                callback=self._on_reading_changed, replay_latest=False,
            )
        self._watch_task = asyncio.create_task(self._watch_css(), name="obs-subtitle-css")
        logger.info("OBS subtitles: http://127.0.0.1:%s/subtitle/ ; CSS editor: /subtitle/editor", self.port)

    async def stop(self) -> None:
        reading_subscription, self._reading_subscription = self._reading_subscription, None
        if reading_subscription is not None:
            reading_subscription.close()
        self._reading_views.clear()
        self._clear_reading_receipt()
        self.clear(reset_sequence=True)
        if self._watch_task is not None:
            self._watch_task.cancel()
            await asyncio.gather(self._watch_task, return_exceptions=True)
            self._watch_task = None
        runner, self._runner = self._runner, None
        if runner is not None:
            await runner.cleanup()

    def publish(self, payload: dict[str, Any], *, turn_id: str, current_turn_id: str | None) -> None:
        validate_subtitle_state(payload)
        if payload["sequence"] <= self._source_sequence:
            return
        self._source_sequence = payload["sequence"]
        state = payload["state"]
        if state in {"speaking", "text"}:
            if not turn_id or turn_id != current_turn_id or not payload["text"].strip():
                return
            self._caption = {"state": state, "text": payload["text"], "turn_id": turn_id,
                             "segment_id": payload["segment_id"], "speaker": self.speaker}
            self._broadcast()
        elif (self._caption["turn_id"] == turn_id
              and self._caption["segment_id"] == payload["segment_id"]):
            if state == "clear":
                self.clear()
            elif self._caption["state"] != "ended":
                self._caption["state"] = "ended"
                self._broadcast()

    def clear(self, *, reset_sequence: bool = False) -> None:
        if reset_sequence:
            self._source_sequence = 0
        self._caption = self._empty_caption()
        self._broadcast()

    def _broadcast(self) -> None:
        self._revision += 1
        snapshot = self.snapshot()
        for queue in tuple(self._subscribers):
            if queue.full():
                queue.get_nowait()
            queue.put_nowait(snapshot)

    async def _reload_css(self) -> None:
        try:
            if self.css_path.stat().st_size > MAX_CSS_BYTES:
                raise ValueError("subtitle_css_too_large")
            css = await asyncio.to_thread(self.css_path.read_text, encoding="utf-8")
            if css != self._css:
                self._css = css
                self._css_revision += 1
                self._broadcast()
        except (OSError, UnicodeError, ValueError) as exc:
            logger.warning("OBS subtitle CSS could not be loaded: %s", exc)

    async def _watch_css(self) -> None:
        previous = None
        while True:
            try:
                stat = self.css_path.stat()
                signature = (stat.st_mtime_ns, stat.st_size)
                if signature != previous:
                    previous = signature
                    await self._reload_css()
            except OSError:
                pass  # Atomic editor saves may briefly replace the file.
            await asyncio.sleep(0.5)

    async def _redirect(self, request: web.Request) -> web.Response:
        raise web.HTTPFound("/subtitle/")

    async def _page(self, request: web.Request) -> web.FileResponse:
        return web.FileResponse(
            self.assets_dir / "index.html",
            headers={"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"},
        )

    async def _editor(self, request: web.Request) -> web.FileResponse:
        return web.FileResponse(self.assets_dir / "editor.html", headers={"Cache-Control": "no-store"})

    async def _custom_css(self, request: web.Request) -> web.Response:
        return web.Response(text=self._css, content_type="text/css", headers={"Cache-Control": "no-store"})

    async def _config(self, request: web.Request) -> web.Response:
        return web.json_response({"css": self._css, "css_path": str(self.css_path)},
                                 headers={"Cache-Control": "no-store"})

    async def _save_css(self, request: web.Request) -> web.Response:
        # Only the local editor may mutate styles. No cross-origin writes.
        if request.headers.get("Origin") != f"{request.scheme}://{request.host}":
            raise web.HTTPForbidden(text="Open the local subtitle editor to save CSS.")
        if request.content_type != "text/css":
            raise web.HTTPUnsupportedMediaType()
        css = await request.text()
        async with self._css_lock:
            temporary = self.css_path.with_suffix(".css.tmp")
            await asyncio.to_thread(temporary.write_text, css, encoding="utf-8")
            await asyncio.to_thread(temporary.replace, self.css_path)
            await self._reload_css()
        return web.json_response({"ok": True})

    def _on_reading_changed(self, _envelope) -> None:
        self._broadcast()

    def _reading_for(self, key: str) -> dict | None:
        if not 24 <= len(key) <= 64 or self._hub is None or self._reading_scope is None:
            return None
        snapshot = self._hub.get_snapshot(
            kind=READING_KIND, source_id=READING_SOURCE, scope=self._reading_scope,
        )
        if snapshot is None:
            return None
        payload = dict(snapshot.payload)
        digest = payload.pop("display_digest", "")
        if (
            self._reading_target is None or payload.get("target") != self._reading_target()
            or not isinstance(digest, str)
            or not secrets.compare_digest(hashlib.sha256(key.encode()).hexdigest(), digest)
        ):
            return None
        return payload

    def _clear_reading_receipt(self) -> None:
        self._rendered_view = None
        self._rendered_identity = None
        if self._hub is not None and self._reading_scope is not None:
            self._hub.clear_snapshots(
                kind=RENDERED_KIND, source_id=RENDERED_SOURCE, scope=self._reading_scope,
            )

    async def _acknowledge_reading(self, request: web.Request) -> web.Response:
        if request.headers.get("Origin") != f"{request.scheme}://{request.host}":
            raise web.HTTPForbidden()
        try:
            body = await request.json()
        except (ValueError, TypeError) as exc:
            raise web.HTTPBadRequest() from exc
        if (
            not isinstance(body, dict)
            or not isinstance(body.get("key"), str)
            or not isinstance(body.get("renderer"), str)
        ):
            raise web.HTTPBadRequest()
        key = body["key"]
        payload = self._reading_for(key)
        view = self._reading_views.get(body["renderer"])
        fields = ("session_id", "visit_id", "display_revision")
        if (
            payload is None or view is None or key != view[0]
            or any(body.get(field) != payload[field] for field in fields)
        ):
            raise web.HTTPConflict()
        identity = tuple(payload[field] for field in fields)
        now = monotonic()
        owner = self._rendered_view
        heartbeat_expired = now - self._last_rendered_heartbeat >= RENDER_RECEIPT_TTL_SECONDS
        if owner is not None and owner != view and owner[0] == key and not heartbeat_expired:
            raise web.HTTPConflict()
        if owner != view or identity != self._rendered_identity or heartbeat_expired:
            self._rendered_view = view
            self._rendered_identity = identity
            self._rendered_at = now
        self._last_rendered_heartbeat = now
        self._hub.publish_snapshot(
            kind=RENDERED_KIND, source_id=RENDERED_SOURCE, scope=self._reading_scope,
            payload={**{field: payload[field] for field in fields}, "target": payload["target"],
                     "rendered_at": self._rendered_at},
            ttl=RENDER_RECEIPT_TTL_SECONDS,
        )
        return web.Response(status=204)

    async def _events(self, request: web.Request) -> web.StreamResponse:
        response = web.StreamResponse(headers={"Content-Type": "text/event-stream",
                                              "Cache-Control": "no-store", "X-Accel-Buffering": "no"})
        await response.prepare(request)
        queue: asyncio.Queue = asyncio.Queue(maxsize=1)
        reading_key = request.query.get("reading", "")
        renderer = request.query.get("renderer", "")
        view = (reading_key, queue)
        view_registered = False
        self._subscribers.add(queue)
        queue.put_nowait(self.snapshot())
        try:
            while True:
                try:
                    snapshot = await asyncio.wait_for(queue.get(), timeout=15)
                except TimeoutError:
                    snapshot = self.snapshot()
                if snapshot is None:
                    break
                if reading_key:
                    reading = self._reading_for(reading_key)
                    if not view_registered and reading is not None and 1 <= len(renderer) <= 64:
                        previous_view = self._reading_views.get(renderer)
                        if previous_view is not None and previous_view == self._rendered_view:
                            self._clear_reading_receipt()
                        self._reading_views[renderer] = view
                        view_registered = True
                    snapshot = {**snapshot, "reading": reading}
                data = json.dumps(snapshot, ensure_ascii=False)
                await response.write(f"data: {data}\n\n".encode())
        except (ConnectionError, RuntimeError):
            pass
        finally:
            self._subscribers.discard(queue)
            if self._reading_views.get(renderer) == view:
                self._reading_views.pop(renderer, None)
            if self._rendered_view == view:
                self._clear_reading_receipt()
        return response

    async def _shutdown_subscribers(self, app: web.Application) -> None:
        for queue in tuple(self._subscribers):
            if queue.full():
                queue.get_nowait()
            queue.put_nowait(None)
