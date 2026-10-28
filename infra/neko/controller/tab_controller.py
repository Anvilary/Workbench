#!/usr/bin/env python3
"""
Restricted Chromium DevTools Protocol (CDP) Tab Controller.

This service acts as a restricted gateway between the MAW runtime and the internal
Chromium instance running inside the Neko container.

Core security invariants:
1. Only tab lifecycle operations are exposed: enumeration, creation, selection/activation,
   navigation, and closure.
2. Arbitrary DOM access, runtime script evaluation (Runtime.evaluate), cookie extraction
   (Network.getCookies), and simulated keystroke/message submission are strictly prohibited
   and have no endpoints.
3. Raw Chromium CDP port (9222) is bound to 127.0.0.1 container-internally and NEVER exposed
   to the external network or host.
4. All navigation/creation URLs are validated against permitted schemes (http, https, about:blank).
"""

import base64
import http.server
import json
import os
import re
import socket
import sys
import urllib.parse
import urllib.request

CDP_HOST = os.environ.get("CDP_HOST", "127.0.0.1")
CDP_PORT = int(os.environ.get("CDP_PORT", "9222"))
CONTROLLER_HOST = os.environ.get("CONTROLLER_HOST", "0.0.0.0")
CONTROLLER_PORT = int(os.environ.get("CONTROLLER_PORT", "9223"))
AUTH_TOKEN = os.environ.get("CONTROLLER_AUTH_TOKEN", "").strip()

SAFE_URL_PATTERN = re.compile(r"^(https?://|about:blank)", re.IGNORECASE)
TAB_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]+$")


def send_cdp_http(path: str, method: str = "GET", timeout: float = 5.0):
    """Sends an HTTP request to the internal Chromium CDP REST endpoint."""
    url = f"http://{CDP_HOST}:{CDP_PORT}{path}"
    req = urllib.request.Request(url, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        content = resp.read().decode("utf-8")
        if content:
            try:
                return json.loads(content)
            except json.JSONDecodeError:
                return content
        return None


def ws_send_cdp_command(ws_url: str, method: str, params: dict = None, timeout: float = 5.0):
    """
    Sends a single CDP command over WebSocket using a minimal zero-dependency
    RFC 6455 client. Used strictly for permitted commands like Page.navigate.
    """
    parts = ws_url.replace("ws://", "").split("/", 1)
    host, port = parts[0].split(":")
    path = "/" + parts[1]

    s = socket.create_connection((host, int(port)), timeout=timeout)
    key = base64.b64encode(os.urandom(16)).decode()
    req = (
        f"GET {path} HTTP/1.1\r\n"
        f"Host: {host}:{port}\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {key}\r\n"
        "Sec-WebSocket-Version: 13\r\n\r\n"
    )
    s.sendall(req.encode())
    resp = s.recv(4096)
    first_line = resp.split(b"\r\n")[0]
    if b"101" not in first_line:
        s.close()
        err_msg = resp.decode(errors="ignore")
        raise RuntimeError(f"WebSocket handshake failed: {err_msg}")

    msg = {"id": 1, "method": method, "params": params or {}}
    payload = json.dumps(msg).encode("utf-8")
    mask = os.urandom(4)
    length = len(payload)
    if length < 126:
        header = bytes([0x81, 0x80 | length])
    elif length < 65536:
        header = bytes([0x81, 0x80 | 126]) + length.to_bytes(2, "big")
    else:
        header = bytes([0x81, 0x80 | 127]) + length.to_bytes(8, "big")

    masked = bytearray(len(payload))
    for i in range(len(payload)):
        masked[i] = payload[i] ^ mask[i % 4]

    s.sendall(header + mask + masked)
    raw_reply = s.recv(4096)
    s.close()
    return raw_reply


class RestrictedTabHandler(http.server.BaseHTTPRequestHandler):
    server_version = "MAW-RestrictedTabController/1.0"

    def _check_auth(self) -> bool:
        if not AUTH_TOKEN:
            return True
        auth_hdr = self.headers.get("Authorization", "")
        if auth_hdr.startswith("Bearer "):
            token = auth_hdr[7:].strip()
            return token == AUTH_TOKEN
        return False

    def _send_json(self, status_code: int, data: dict):
        body = json.dumps(data).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_error(self, status_code: int, message: str):
        self._send_json(status_code, {"error": message, "code": status_code})

    def do_GET(self):
        if not self._check_auth():
            return self._send_error(401, "Unauthorized")

        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path.rstrip("/")

        if path in ("/health", "/status"):
            try:
                ver = send_cdp_http("/json/version")
                targets = send_cdp_http("/json/list")
                page_tabs = [t for t in targets if isinstance(t, dict) and t.get("type") == "page"]
                return self._send_json(200, {
                    "status": "healthy",
                    "browser": ver.get("Browser", "unknown") if isinstance(ver, dict) else "unknown",
                    "tabs_count": len(page_tabs),
                })
            except Exception as e:
                return self._send_error(503, f"CDP backend unavailable: {str(e)}")

        elif path == "/tabs":
            try:
                targets = send_cdp_http("/json/list")
                clean_tabs = []
                for t in targets:
                    if isinstance(t, dict) and t.get("type") == "page":
                        clean_tabs.append({
                            "id": t.get("id"),
                            "title": t.get("title", ""),
                            "url": t.get("url", ""),
                            "faviconUrl": t.get("faviconUrl", ""),
                        })
                return self._send_json(200, {"tabs": clean_tabs, "count": len(clean_tabs)})
            except Exception as e:
                return self._send_error(500, f"Failed to list tabs: {str(e)}")

        else:
            return self._send_error(404, "Endpoint not found")

    def do_POST(self):
        if not self._check_auth():
            return self._send_error(401, "Unauthorized")

        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path.rstrip("/")

        content_len = int(self.headers.get("Content-Length", 0))
        body = {}
        if content_len > 0:
            try:
                body = json.loads(self.rfile.read(content_len).decode("utf-8"))
            except Exception:
                return self._send_error(400, "Invalid JSON payload")

        if path == "/tabs":
            # Tab creation
            target_url = body.get("url", "https://chatgpt.com")
            if not SAFE_URL_PATTERN.match(target_url):
                return self._send_error(400, "Invalid URL scheme: only http, https, and about:blank allowed")

            encoded_url = urllib.parse.quote(target_url, safe=":/?#[]@!$&'()*+,;=")
            try:
                new_tab = send_cdp_http(f"/json/new?{encoded_url}", method="PUT")
                if isinstance(new_tab, dict):
                    return self._send_json(201, {
                        "id": new_tab.get("id"),
                        "title": new_tab.get("title", ""),
                        "url": new_tab.get("url", target_url),
                        "created": True,
                    })
                return self._send_error(500, "Unexpected CDP response when creating tab")
            except Exception as e:
                return self._send_error(500, f"Failed to create tab: {str(e)}")

        # Handle tab action endpoints: /tabs/{id}/{action}
        parts = path.split("/")
        if len(parts) == 4 and parts[1] == "tabs":
            tab_id = parts[2]
            action = parts[3]

            if not TAB_ID_PATTERN.match(tab_id):
                return self._send_error(400, "Invalid tab ID format")

            if action in ("activate", "select"):
                try:
                    res = send_cdp_http(f"/json/activate/{tab_id}", method="PUT")
                    return self._send_json(200, {"id": tab_id, "activated": True, "result": res})
                except Exception as e:
                    return self._send_error(500, f"Failed to activate tab: {str(e)}")

            elif action == "navigate":
                dest_url = body.get("url", "")
                if not SAFE_URL_PATTERN.match(dest_url):
                    return self._send_error(400, "Invalid URL scheme: only http, https, and about:blank allowed")

                try:
                    targets = send_cdp_http("/json/list")
                    target = next((t for t in targets if isinstance(t, dict) and t.get("id") == tab_id), None)
                    if not target or not target.get("webSocketDebuggerUrl"):
                        return self._send_error(404, f"Tab {tab_id} not found or has no debugger endpoint")

                    ws_url = target["webSocketDebuggerUrl"]
                    ws_send_cdp_command(ws_url, "Page.navigate", {"url": dest_url})
                    return self._send_json(200, {"id": tab_id, "navigated": True, "url": dest_url})
                except Exception as e:
                    return self._send_error(500, f"Failed to navigate tab: {str(e)}")

            elif action == "close":
                try:
                    res = send_cdp_http(f"/json/close/{tab_id}", method="PUT")
                    return self._send_json(200, {"id": tab_id, "closed": True, "result": res})
                except Exception as e:
                    return self._send_error(500, f"Failed to close tab: {str(e)}")

        return self._send_error(404, "Endpoint not found")

    def do_DELETE(self):
        if not self._check_auth():
            return self._send_error(401, "Unauthorized")

        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path.rstrip("/")
        parts = path.split("/")

        if len(parts) == 3 and parts[1] == "tabs":
            tab_id = parts[2]
            if not TAB_ID_PATTERN.match(tab_id):
                return self._send_error(400, "Invalid tab ID format")
            try:
                res = send_cdp_http(f"/json/close/{tab_id}", method="PUT")
                return self._send_json(200, {"id": tab_id, "closed": True, "result": res})
            except Exception as e:
                return self._send_error(500, f"Failed to close tab: {str(e)}")

        return self._send_error(404, "Endpoint not found")

    def log_message(self, format, *args):
        sys.stdout.write(f"[RestrictedTabController] {self.address_string()} - {format % args}\n")
        sys.stdout.flush()


def run():
    print(f"[RestrictedTabController] Starting on {CONTROLLER_HOST}:{CONTROLLER_PORT}")
    print(f"[RestrictedTabController] Connected to CDP on {CDP_HOST}:{CDP_PORT}")
    if AUTH_TOKEN:
        print("[RestrictedTabController] Bearer token authentication ENABLED")
    else:
        print("[RestrictedTabController] Local-only unauthenticated mode (bound to localhost/container network)")
    server = http.server.ThreadingHTTPServer((CONTROLLER_HOST, CONTROLLER_PORT), RestrictedTabHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    run()
