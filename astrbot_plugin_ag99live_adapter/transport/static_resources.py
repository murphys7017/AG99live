"""Minimal HTTP static resource server for the desktop VTuber adapter."""

from __future__ import annotations

import json
import mimetypes
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable
from urllib.parse import unquote, urlparse

from astrbot.api import logger


ApiRequestHandler = Callable[[str, dict[str, Any]], tuple[int, dict[str, Any]]]


def _build_handler(
    routes: dict[str, Path],
    *,
    api_handler: ApiRequestHandler | None = None,
):
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
            self.send_header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS, POST")
            self.send_header("Access-Control-Allow-Headers", "*")
            super().end_headers()

        def do_OPTIONS(self) -> None:  # noqa: N802
            self.send_response(200)
            self.end_headers()

        def do_POST(self) -> None:  # noqa: N802
            if api_handler is None:
                self._send_json_response(404, {"ok": False, "error": "API handler is not configured."})
                return

            parsed_path = urlparse(self.path).path
            request_path = unquote(parsed_path)
            if not request_path.startswith("/api/"):
                self._send_json_response(404, {"ok": False, "error": "Not found."})
                return

            content_length = int(self.headers.get("Content-Length") or 0)
            raw_body = self.rfile.read(content_length) if content_length > 0 else b"{}"
            try:
                payload = json.loads(raw_body.decode("utf-8")) if raw_body else {}
            except json.JSONDecodeError:
                self._send_json_response(400, {"ok": False, "error": "Invalid JSON payload."})
                return

            if not isinstance(payload, dict):
                self._send_json_response(400, {"ok": False, "error": "JSON payload must be an object."})
                return

            try:
                status_code, response_payload = api_handler(request_path, payload)
            except Exception as exc:  # pragma: no cover - defensive fallback.
                self._send_json_response(500, {"ok": False, "error": f"API handler failed: {exc}"})
                return

            if not isinstance(response_payload, dict):
                response_payload = {"ok": False, "error": "API handler returned invalid payload."}
                status_code = 500
            self._send_json_response(status_code, response_payload)

        def guess_type(self, path: str) -> str:
            content_type, _ = mimetypes.guess_type(path)
            return content_type or "application/octet-stream"

        def _send_json_response(self, status_code: int, payload: dict[str, Any]) -> None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status_code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format: str, *args) -> None:
            return

    return StaticResourceHandler


class StaticResourceServer:
    """Threaded HTTP server that exposes a few static directories."""

    def __init__(
        self,
        host: str,
        port: int,
        routes: dict[str, Path],
        *,
        api_handler: ApiRequestHandler | None = None,
    ):
        self.host = host
        self.port = port
        self.routes = routes
        self.api_handler = api_handler
        self._server: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if self._server is not None:
            return

        handler_cls = _build_handler(
            self.routes,
            api_handler=self.api_handler,
        )
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
