"""Minimal HTTP static resource server for the desktop VTuber adapter."""

from __future__ import annotations

import mimetypes
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

from astrbot.api import logger


def _build_handler(routes: dict[str, Path]):
    normalized_routes = {prefix: path.resolve() for prefix, path in routes.items()}

    class StaticResourceHandler(SimpleHTTPRequestHandler):
        def translate_path(self, path: str) -> str:
            parsed_path = urlparse(path).path
            request_path = unquote(parsed_path)

            for prefix, root in normalized_routes.items():
                if request_path == prefix or request_path.startswith(prefix + "/"):
                    relative = request_path[len(prefix) :].lstrip("/\\")
                    target = (root / relative).resolve()
                    try:
                        target.relative_to(root)
                    except ValueError:
                        return str(root / "__forbidden__")
                    return str(target)

            return str(Path("__missing__").resolve())

        def end_headers(self) -> None:
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "*")
            super().end_headers()

        def do_OPTIONS(self) -> None:  # noqa: N802
            self.send_response(200)
            self.end_headers()

        def guess_type(self, path: str) -> str:
            content_type, _ = mimetypes.guess_type(path)
            return content_type or "application/octet-stream"

        def log_message(self, format: str, *args) -> None:
            return

    return StaticResourceHandler


class StaticResourceServer:
    """Threaded HTTP server that exposes a few static directories."""

    def __init__(self, host: str, port: int, routes: dict[str, Path]):
        self.host = host
        self.port = port
        self.routes = routes
        self._server: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if self._server is not None:
            return

        handler_cls = _build_handler(self.routes)
        self._server = ThreadingHTTPServer((self.host, self.port), handler_cls)
        self._thread = threading.Thread(
            target=self._server.serve_forever,
            name=f"desktop_vtuber_static_{self.port}",
            daemon=True,
        )
        self._thread.start()
        logger.info(
            f"Desktop VTuber static resources listening on http://{self.host}:{self.port}"
        )

    def stop(self) -> None:
        if self._server is None:
            return

        self._server.shutdown()
        self._server.server_close()
        self._server = None

        if self._thread is not None:
            self._thread.join(timeout=2)
            self._thread = None
