"""Local Windows host for the desktop frontend and unchanged TLC backend.

The hosted Streamlit component already separates the interface from the Python
analysis. This small loopback server keeps that same request/response contract
while avoiding a Streamlit runtime in the portable Windows package.
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import sys
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

import tlc_backend


MAX_REQUEST_BYTES = 20 * 1024 * 1024
FRONTEND_DIR = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent.parent)) / "frontend"


def response_for(message: object) -> dict:
    """Return the same versioned envelope as streamlit_app.py.

    Keeping this shape lets the desktop UI use its existing profile and crop
    response handlers. All scientific calculations still run in tlc_backend.
    """
    action = message.get("action") if isinstance(message, dict) else None
    request_id = str(message.get("request_id", "")) if isinstance(message, dict) else ""
    payload = message.get("payload", {}) if isinstance(message, dict) else None
    version = message.get("protocol_version") if isinstance(message, dict) else None

    def envelope(ok: bool, data: object = None, error: dict | None = None) -> dict:
        return {
            "protocol_version": 1,
            "action": f"{action}_result" if isinstance(action, str) and action else "protocol_error_result",
            "request_id": request_id,
            "ok": ok,
            "data": data if ok else None,
            "error": error,
        }

    if version != 1 or not isinstance(action, str) or not action or not request_id or len(request_id) > 128:
        return envelope(False, error={"code": "INVALID_PROTOCOL", "message": "The application sent an invalid request.", "retryable": False})
    if not isinstance(payload, dict):
        return envelope(False, error={"code": "INVALID_PROTOCOL", "message": "The request data is invalid.", "retryable": False})

    if action == "generate_profiles":
        result = tlc_backend.generate_profiles(payload)
    elif action == "crop":
        result = tlc_backend.crop_image(payload)
    else:
        return envelope(False, error={"code": "UNKNOWN_ACTION", "message": "That action is not supported.", "retryable": False})

    if result.get("error"):
        code = result.get("error_code", "PROCESSING_ERROR")
        return envelope(False, error={"code": code, "message": result["error"], "retryable": code == "PROCESSING_ERROR"})
    return envelope(True, data=result)


class AppServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


class AppHandler(BaseHTTPRequestHandler):
    server_version = "AQ-TLC-Desktop/1.0"

    def _send_bytes(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def _send_json(self, status: int, value: object) -> None:
        self._send_bytes(status, json.dumps(value, allow_nan=False).encode("utf-8"), "application/json; charset=utf-8")

    def _same_origin(self) -> bool:
        port = self.server.server_address[1]
        expected = f"127.0.0.1:{port}"
        host = self.headers.get("Host", "")
        origin = self.headers.get("Origin")
        return host == expected and (origin is None or origin == f"http://{expected}")

    def do_GET(self) -> None:
        if not self._same_origin():
            self.send_error(403)
            return
        request_path = unquote(urlsplit(self.path).path)
        if request_path == "/health":
            self._send_json(200, {"status": "ok", "application": "AQ-TLC Desktop"})
            return

        # Resolve every static request beneath the copied frontend directory.
        # This also rejects URL-encoded traversal and Windows path variants.
        relative = request_path.lstrip("/") or "index.html"
        root = FRONTEND_DIR.resolve()
        target = (root / relative).resolve()
        if not target.is_relative_to(root) or not target.is_file():
            self.send_error(404)
            return
        media_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        if media_type.startswith("text/") or media_type in {"application/javascript", "application/json"}:
            media_type += "; charset=utf-8"
        self._send_bytes(200, target.read_bytes(), media_type)

    def do_POST(self) -> None:
        if urlsplit(self.path).path != "/api":
            self.send_error(404)
            return
        if not self._same_origin() or self.headers.get_content_type() != "application/json":
            self.send_error(403)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length < 1 or length > MAX_REQUEST_BYTES:
            self.send_error(413)
            return
        try:
            message = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._send_json(400, {"error": "The request is not valid JSON."})
            return
        self._send_json(200, response_for(message))


def main() -> None:
    parser = argparse.ArgumentParser(description="Run AQ-TLC Desktop locally")
    parser.add_argument("--no-browser", action="store_true", help="Keep the browser closed for automated checks")
    parser.add_argument("--port", type=int, default=0, help="Loopback port; 0 selects an available port")
    args = parser.parse_args()
    if not FRONTEND_DIR.is_dir():
        raise SystemExit(f"Application interface is missing: {FRONTEND_DIR}")

    server = AppServer(("127.0.0.1", args.port), AppHandler)
    url = f"http://127.0.0.1:{server.server_address[1]}"
    print(f"AQ-TLC Desktop is ready at {url}", flush=True)
    print("Close this window to stop the app.", flush=True)
    if not args.no_browser:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
