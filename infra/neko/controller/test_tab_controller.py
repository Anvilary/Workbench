#!/usr/bin/env python3
"""
Unit and functional tests for the Restricted Chromium CDP Tab Controller.
Tests origin restrictions, tab ID validation, token authentication, and WebSocket framing.
"""

import hmac
import base64
import hashlib
import json
import os
import sys
import unittest
from unittest.mock import patch

# Configure valid test auth token before importing controller module
os.environ["CONTROLLER_AUTH_TOKEN"] = "test_secret_token_at_least_32_characters_long_12345"

sys.path.insert(0, os.path.dirname(__file__))
from tab_controller import is_url_permitted, TAB_ID_PATTERN, RobustCDPWebSocketClient


class TestRestrictedTabController(unittest.TestCase):
    def test_permitted_origins(self):
        # Permitted ChatGPT and official auth origins
        self.assertTrue(is_url_permitted("https://chatgpt.com")[0])
        self.assertTrue(is_url_permitted("https://chatgpt.com/c/67890-abcdef")[0])
        self.assertTrue(is_url_permitted("https://auth.openai.com/login")[0])
        self.assertTrue(is_url_permitted("https://cdn.oaistatic.com/assets/app.js")[0])
        self.assertTrue(is_url_permitted("https://accounts.google.com/o/oauth2/v2/auth")[0])
        self.assertTrue(is_url_permitted("https://login.microsoftonline.com/common/oauth2/authorize")[0])
        self.assertTrue(is_url_permitted("https://login.live.com/oauth20_authorize.srf")[0])
        self.assertTrue(is_url_permitted("https://appleid.apple.com/auth/authorize")[0])
        self.assertTrue(is_url_permitted("about:blank")[0])

    def test_blocked_loopback_and_internal_origins(self):
        # Loopback
        self.assertFalse(is_url_permitted("http://127.0.0.1:8080/")[0])
        self.assertFalse(is_url_permitted("https://127.0.0.1:9222/json")[0])
        self.assertFalse(is_url_permitted("http://localhost:3000")[0])
        self.assertFalse(is_url_permitted("http://sub.localhost:8080")[0])

        # RFC 1918 Private networks
        self.assertFalse(is_url_permitted("http://10.0.0.1/admin")[0])
        self.assertFalse(is_url_permitted("http://172.17.0.1:8080/api")[0])
        self.assertFalse(is_url_permitted("http://192.168.1.1/")[0])

        # Cloud metadata services
        self.assertFalse(is_url_permitted("http://169.254.169.254/latest/meta-data")[0])
        self.assertFalse(is_url_permitted("http://metadata.google.internal/computeMetadata/v1/")[0])

    def test_blocked_unsafe_schemes(self):
        # Dangerous and unapproved schemes
        self.assertFalse(is_url_permitted("file:///etc/passwd")[0])
        self.assertFalse(is_url_permitted("javascript:alert(1)")[0])
        self.assertFalse(is_url_permitted("data:text/html,<h1>Pwned</h1>")[0])
        self.assertFalse(is_url_permitted("chrome://policy")[0])
        self.assertFalse(is_url_permitted("chrome://flags")[0])
        self.assertFalse(is_url_permitted("gopher://evil.com")[0])
        self.assertFalse(is_url_permitted("ftp://ftp.example.com")[0])

    def test_https_credentials_and_ports_are_enforced(self):
        for value in ("http://chatgpt.com/", "https://user:pass@chatgpt.com/", "https://chatgpt.com:9443/", "https://chatgpt.com:bad/", "https://chatgpt.com/\nfoo", None):
            self.assertFalse(is_url_permitted(value)[0], value)

    def test_blocked_unapproved_external_origins(self):
        # External unapproved domains
        self.assertFalse(is_url_permitted("https://evil-hacker.com")[0])
        self.assertFalse(is_url_permitted("https://malicious.org/exploit")[0])
        self.assertFalse(is_url_permitted("https://chatgpt.com.attacker.com")[0])

    def test_tab_id_pattern(self):
        # Valid IDs
        self.assertTrue(TAB_ID_PATTERN.match("C47A2F986A2EFD254707328A0003FBED"))
        self.assertTrue(TAB_ID_PATTERN.match("tab-123_456"))
        self.assertTrue(TAB_ID_PATTERN.match("abc-DEF-098"))

        # Injections and path traversal
        self.assertFalse(TAB_ID_PATTERN.match("../../evil"))
        self.assertFalse(TAB_ID_PATTERN.match("id/with/slashes"))
        self.assertFalse(TAB_ID_PATTERN.match("id with spaces"))
        self.assertFalse(TAB_ID_PATTERN.match("id;rm -rf /"))
        self.assertFalse(TAB_ID_PATTERN.match("id\nnewline"))

    def test_timing_safe_token_comparison(self):
        secret = "0123456789abcdef0123456789abcdef"
        valid = "0123456789abcdef0123456789abcdef"
        invalid = "0123456789abcdef0123456789abcdeg"
        short = "0123456789"

        self.assertTrue(hmac.compare_digest(valid.encode("utf-8"), secret.encode("utf-8")))
        self.assertFalse(hmac.compare_digest(invalid.encode("utf-8"), secret.encode("utf-8")))
        self.assertFalse(hmac.compare_digest(short.encode("utf-8"), secret.encode("utf-8")))

    def test_websocket_ping_payload_and_utf8_fragmentation(self):
        class Socket:
            def __init__(self, incoming):
                self.incoming = incoming
                self.sent = []
            def recv(self, size):
                result, self.incoming = self.incoming[:size], self.incoming[size:]
                return result
            def sendall(self, payload):
                self.sent.append(payload)
            def settimeout(self, _timeout):
                pass

        payload = json.dumps({"id": 1, "result": {"text": "é"}}, ensure_ascii=False).encode()
        split = payload.index(b"\xc3") + 1
        incoming = b"\x89\x03abc" + bytes([0x01, split]) + payload[:split] + bytes([0x80, len(payload) - split]) + payload[split:]
        client = RobustCDPWebSocketClient("ws://127.0.0.1:9222/devtools/page/one")
        client.sock = Socket(incoming)
        self.assertEqual(client.send_command("Page.navigate"), {"text": "é"})
        pong = client.sock.sent[1]
        self.assertEqual(pong[:2], b"\x8a\x83")
        mask = pong[2:6]
        self.assertEqual(bytes(value ^ mask[index % 4] for index, value in enumerate(pong[6:])), b"abc")

    def test_websocket_retains_frames_received_with_upgrade_headers(self):
        class Socket:
            incoming = b""
            def settimeout(self, _timeout):
                pass
            def recv(self, size):
                result, self.incoming = self.incoming[:size], self.incoming[size:]
                return result
            def sendall(self, data):
                if data.startswith(b"GET "):
                    key = next(line.split(b":", 1)[1].strip() for line in data.split(b"\r\n") if line.startswith(b"Sec-WebSocket-Key:"))
                    accept = base64.b64encode(hashlib.sha1(key + b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest())
                    payload = b'{"id":1,"result":{"frameId":"one"}}'
                    self.incoming = b"HTTP/1.1 101 Switching Protocols\r\nSec-WebSocket-Accept: " + accept + b"\r\n\r\n" + bytes([0x81, len(payload)]) + payload

        with patch("tab_controller.socket.create_connection", return_value=Socket()):
            client = RobustCDPWebSocketClient("ws://127.0.0.1:9222/devtools/page/one")
            client.connect()
            self.assertEqual(client.send_command("Page.navigate"), {"frameId": "one"})


if __name__ == "__main__":
    unittest.main()
