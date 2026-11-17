"""Read-only OBS subtitle projection, separate from the desktop transport."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

from aiohttp import web

from astrbot.api import logger

from ..protocol.subtitle import validate_subtitle_state

MAX_CSS_BYTES = 64 * 1024


class SubtitleWebService:
    """Project actual playback facts; OBS never owns playback acknowledgements."""

    def __init__(self, *, port: int, assets_dir: Path, css_path: Path, speaker: str):
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
        self._watch_task = asyncio.create_task(self._watch_css(), name="obs-subtitle-css")
        logger.info("OBS subtitles: http://127.0.0.1:%s/subtitle/ ; CSS editor: /subtitle/editor", self.port)

    async def stop(self) -> None:
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
        return web.FileResponse(self.assets_dir / "index.html", headers={"Cache-Control": "no-store"})

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

    async def _events(self, request: web.Request) -> web.StreamResponse:
        response = web.StreamResponse(headers={"Content-Type": "text/event-stream",
                                              "Cache-Control": "no-store", "X-Accel-Buffering": "no"})
        await response.prepare(request)
        queue: asyncio.Queue = asyncio.Queue(maxsize=1)
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
                data = json.dumps(snapshot, ensure_ascii=False)
                await response.write(f"data: {data}\n\n".encode())
        except (ConnectionError, RuntimeError):
            pass
        finally:
            self._subscribers.discard(queue)
        return response

    async def _shutdown_subscribers(self, app: web.Application) -> None:
        for queue in tuple(self._subscribers):
            if queue.full():
                queue.get_nowait()
            queue.put_nowait(None)
