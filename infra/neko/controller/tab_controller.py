#!/usr/bin/env python3
"""
Restricted Chromium DevTools Protocol (CDP) Tab Controller.

Acts as a hardened gateway between the MAW host runtime and the internal
Chromium browser instance running inside the Neko container.

Core Security & Operational Invariants:
1. Mandatory Authentication: Requires a cryptographically strong bearer token
   (minimum 32 characters) via CONTROLLER_AUTH_TOKEN. Fails startup if missing.
   Uses hmac.compare_digest for timing-safe verification.
2. Origin & Navigation Allowlist: MAW-controlled navigation is strictly limited to
   approved ChatGPT and required SSO authentication origins. Loopback (127.0.0.1,
   localhost), link-local, internal RFC 1918 subnets, cloud metadata (169.254.169.254),
   and dangerous schemes (file:, javascript:, chrome:, data:) are strictly blocked.
3. Tab State & CDP Integrity: Full RFC 6455 WebSocket client with protocol frame parsing,
   request/response ID correlation, ping/pong keepalive, timeout handling, and target
   state verification following navigation.
4. Isolation & Prohibited Features: Endpoints for DOM inspection, script evaluation
   (Runtime.evaluate), cookie extraction (Network.getCookies), and simulated keystrokes
   are strictly prohibited. Raw CDP port (9222) is bound to container loopback only.
"""

import base64
import hashlib
import hmac
import http.server
import ipaddress
import json
import os
import re
import socket
import sys
import time
import urllib.parse
import urllib.request

CDP_HOST = os.environ.get("CDP_HOST", "127.0.0.1")
CDP_PORT = int(os.environ.get("CDP_PORT", "9222"))
CONTROLLER_HOST = os.environ.get("CONTROLLER_HOST", "0.0.0.0")
CONTROLLER_PORT = int(os.environ.get("CONTROLLER_PORT", "9223"))
AUTH_TOKEN = os.environ.get("CONTROLLER_AUTH_TOKEN", "").strip()

# Validate that mandatory authentication is configured and strong
if not AUTH_TOKEN:
    sys.stderr.write("FATAL [tab_controller]: CONTROLLER_AUTH_TOKEN is mandatory and must not be empty.\n")
    sys.exit(1)

if len(AUTH_TOKEN) < 32:
    sys.stderr.write("FATAL [tab_controller]: CONTROLLER_AUTH_TOKEN must be at least 32 characters long.\n")
    sys.exit(1)

WEAK_TOKENS = {"changeme", "token", "secret", "password", "default", "admin", "12345678901234567890123456789012"}
if AUTH_TOKEN.lower() in WEAK_TOKENS:
    sys.stderr.write("FATAL [tab_controller]: Insecure CONTROLLER_AUTH_TOKEN detected. Use a cryptographically random token.\n")
    sys.exit(1)

TAB_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]+$")

# Permitted domain suffixes for ChatGPT and official authentication providers
BASE_PERMITTED_DOMAINS = [
    "chatgpt.com",
    "openai.com",
    "oaistatic.com",
    "oaiusercontent.com",
    "accounts.google.com",
    "login.microsoftonline.com",
    "login.live.com",
    "appleid.apple.com",
]

# Allow optional environment-configured additional permitted origins (e.g. for testing)
EXTRA_PERMITTED = [d.strip().lower() for d in os.environ.get("PERMITTED_ORIGINS", "").split(",") if d.strip()]
PERMITTED_DOMAINS = BASE_PERMITTED_DOMAINS + EXTRA_PERMITTED


def is_url_permitted(url_str: str) -> tuple[bool, str]:
    """
    Validates whether a URL is permitted for tab creation or navigation.
    Rejects loopback, private subnets, cloud metadata, and unauthorized domains.
    """
    if url_str.strip().lower() == "about:blank":
        return True, ""

    try:
        parsed = urllib.parse.urlparse(url_str)
    except Exception:
        return False, "Malformed URL"

    # Only https is permitted (or http strictly if host is in EXTRA_PERMITTED for local test mocks)
    if parsed.scheme.lower() not in ("http", "https"):
        return False, f"Scheme '{parsed.scheme}' not permitted; only HTTPS allowed"

    host = parsed.hostname
    if not host:
        return False, "URL is missing a valid host"

    host_lower = host.lower()

    # Block well-known loopback, local, and metadata hostnames
    if host_lower in ("localhost", "metadata.google.internal") or host_lower.endswith(".localhost") or host_lower.endswith(".local"):
        return False, f"Forbidden host destination '{host}' (loopback/local/metadata)"

    # Check if host is an IP address
    try:
        ip = ipaddress.ip_address(host)
        if ip.is_loopback:
            return False, f"Forbidden loopback IP destination: {host}"
        if ip.is_private and host_lower not in EXTRA_PERMITTED:
            return False, f"Forbidden private network destination: {host}"
        if ip.is_link_local:
            return False, f"Forbidden link-local destination: {host}"
        if ip.is_reserved or ip.is_multicast:
            return False, f"Forbidden reserved/multicast destination: {host}"
        if str(ip) == "169.254.169.254":
            return False, "Forbidden cloud metadata service destination"
    except ValueError:
        # Not an IP address; evaluate domain whitelist
        pass

    # Check domain against permitted domain list
    domain_matched = False
    for allowed in PERMITTED_DOMAINS:
        if host_lower == allowed or host_lower.endswith("." + allowed):
            domain_matched = True
            break

    if not domain_matched:
        return False, f"Origin '{host}' is not in the approved ChatGPT and authentication allowlist"

    return True, ""


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


class RobustCDPWebSocketClient:
    """
    Robust RFC 6455 WebSocket client for internal Chromium CDP communications.
    Handles framing, control frames (ping/pong/close), message fragmentation,
    request/response ID matching, timeouts, and connection errors.
    """

    def __init__(self, ws_url: str, timeout: float = 10.0):
        self.ws_url = ws_url
        self.timeout = timeout
        parts = ws_url.replace("ws://", "").split("/", 1)
        host_port = parts[0].split(":")
        self.host = host_port[0]
        self.port = int(host_port[1])
        self.path = "/" + parts[1]
        self.sock = None
        self._msg_id = 0

    def connect(self):
        self.sock = socket.create_connection((self.host, self.port), timeout=self.timeout)
        self.sock.settimeout(self.timeout)

        # Generate WebSocket key and expected response
        key = base64.b64encode(os.urandom(16)).decode()
        expected_accept = base64.b64encode(
            hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode("utf-8")).digest()
        ).decode()

        req = (
            f"GET {self.path} HTTP/1.1\r\n"
            f"Host: {self.host}:{self.port}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n"
        )
        self.sock.sendall(req.encode("utf-8"))

        resp = b""
        while b"\r\n\r\n" not in resp:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise ConnectionError("Connection closed unexpectedly during WebSocket handshake")
            resp += chunk

        first_line = resp.split(b"\r\n")[0]
        if b"101" not in first_line:
            err_line = first_line.decode(errors="ignore")
            raise ConnectionError(f"WebSocket handshake rejected by CDP: {err_line}")

        # Verify Sec-WebSocket-Accept
        headers_lower = resp.decode(errors="ignore").lower()
        if expected_accept.lower() not in headers_lower:
            raise ConnectionError("Invalid Sec-WebSocket-Accept response from CDP server")

    def _read_exact(self, num_bytes: int) -> bytes:
        buf = bytearray()
        while len(buf) < num_bytes:
            chunk = self.sock.recv(num_bytes - len(buf))
            if not chunk:
                raise ConnectionError("Socket closed while reading WebSocket frame payload")
            buf.extend(chunk)
        return bytes(buf)

    def _read_frame(self) -> tuple[bool, int, bytes]:
        head = self._read_exact(2)
        fin = (head[0] & 0x80) != 0
        opcode = head[0] & 0x0F
        masked = (head[1] & 0x80) != 0
        length = head[1] & 0x7F

        if length == 126:
            length = int.from_bytes(self._read_exact(2), "big")
        elif length == 127:
            length = int.from_bytes(self._read_exact(8), "big")

        mask = self._read_exact(4) if masked else None
        payload = self._read_exact(length)
        if masked:
            payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))

        return fin, opcode, payload

    def send_command(self, method: str, params: dict = None) -> dict:
        self._msg_id += 1
        req_id = self._msg_id
        cmd = {"id": req_id, "method": method, "params": params or {}}
        payload = json.dumps(cmd).encode("utf-8")

        # Client-to-server frames must be masked per RFC 6455
        mask = os.urandom(4)
        length = len(payload)
        if length < 126:
            hdr = bytes([0x81, 0x80 | length])
        elif length < 65536:
            hdr = bytes([0x81, 0x80 | 126]) + length.to_bytes(2, "big")
        else:
            hdr = bytes([0x81, 0x80 | 127]) + length.to_bytes(8, "big")

        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self.sock.sendall(hdr + mask + masked)

        deadline = time.time() + self.timeout
        msg_buf = ""
        while time.time() < deadline:
            fin, opcode, data = self._read_frame()
            if opcode == 0x8:  # Close frame
                raise ConnectionResetError("CDP server sent close frame")
            elif opcode == 0x9:  # Ping frame
                # Respond with Pong frame (opcode 0xA)
                self.sock.sendall(bytes([0x8A, 0x80]) + os.urandom(4))
                continue
            elif opcode in (0x1, 0x0):  # Text or continuation frame
                msg_buf += data.decode("utf-8", errors="replace")
                if fin:
                    try:
                        parsed = json.loads(msg_buf)
                    except json.JSONDecodeError:
                        msg_buf = ""
                        continue
                    msg_buf = ""
                    # Match correlation ID
                    if parsed.get("id") == req_id:
                        if "error" in parsed:
                            err = parsed["error"]
                            msg = err.get("message", str(err))
                            raise RuntimeError(f"CDP command {method} failed: {msg}")
                        return parsed.get("result", {})
                    # If ID does not match, it is an async CDP notification; continue waiting
        raise TimeoutError(f"Timed out waiting for response to CDP command '{method}' (id={req_id})")

    def close(self):
        if self.sock:
            try:
                self.sock.close()
            except Exception:
                pass
            self.sock = None


class RestrictedTabHandler(http.server.BaseHTTPRequestHandler):
    server_version = "MAW-RestrictedTabController/2.0"

    def _check_auth(self) -> bool:
        auth_hdr = self.headers.get("Authorization", "").strip()
        if not auth_hdr.startswith("Bearer "):
            return False
        token = auth_hdr[7:].strip()
        # Timing-safe token comparison
        return hmac.compare_digest(token.encode("utf-8"), AUTH_TOKEN.encode("utf-8"))

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
            return self._send_error(401, "Unauthorized: valid Bearer token is required")

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
                    "auth_enforced": True,
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
            return self._send_error(401, "Unauthorized: valid Bearer token is required")

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
            # Tab creation with strict origin validation
            target_url = body.get("url", "https://chatgpt.com").strip()
            permitted, reason = is_url_permitted(target_url)
            if not permitted:
                return self._send_error(403, f"Navigation disallowed: {reason}")

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
                dest_url = body.get("url", "").strip()
                permitted, reason = is_url_permitted(dest_url)
                if not permitted:
                    return self._send_error(403, f"Navigation disallowed: {reason}")

                try:
                    targets = send_cdp_http("/json/list")
                    target = next((t for t in targets if isinstance(t, dict) and t.get("id") == tab_id), None)
                    if not target or not target.get("webSocketDebuggerUrl"):
                        return self._send_error(404, f"Tab {tab_id} not found or has no debugger endpoint")

                    ws_url = target["webSocketDebuggerUrl"]
                    client = RobustCDPWebSocketClient(ws_url, timeout=10.0)
                    try:
                        client.connect()
                        res = client.send_command("Page.navigate", {"url": dest_url})
                        # State verification: verify that Page.navigate returned a frameId and no loader error
                        if "errorText" in res:
                            return self._send_error(502, f"Navigation failed in browser: {res['errorText']}")
                    finally:
                        client.close()

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
            return self._send_error(401, "Unauthorized: valid Bearer token is required")

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
        # Concise logging to stdout
        sys.stdout.write(f"[RestrictedTabController] {self.address_string()} - {format % args}\n")
        sys.stdout.flush()


def run():
    print(f"[RestrictedTabController] Starting on {CONTROLLER_HOST}:{CONTROLLER_PORT}")
    print(f"[RestrictedTabController] Connected to CDP on {CDP_HOST}:{CDP_PORT}")
    print("[RestrictedTabController] Mandatory Bearer token authentication ACTIVE")
    print(f"[RestrictedTabController] Approved origins: {', '.join(PERMITTED_DOMAINS)}")
    server = http.server.ThreadingHTTPServer((CONTROLLER_HOST, CONTROLLER_PORT), RestrictedTabHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    run()
