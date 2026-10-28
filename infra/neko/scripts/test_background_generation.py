#!/usr/bin/env python3
"""
Synthetic Background Network & Streaming Continuity Benchmark.

IMPORTANT CLASSIFICATION:
This test proves synthetic background-network continuity: that Chromium keeps
HTTP Server-Sent Event (SSE) and fetch streams active and processes chunks
without timer throttling, renderer freezing, or socket closure while a tab
is occluded in the background.

It does NOT represent or claim genuine ChatGPT completion detection (as ChatGPT
does not expose an external non-DOM status signal). Real-browser user acceptance
requires live interactive testing with authenticated chatgpt.com.
"""

import http.server
import json
import os
import sys
import threading
import time
import urllib.request

def get_docker_gateway() -> str:
    if "GATEWAY_IP" in os.environ:
        return os.environ["GATEWAY_IP"]
    try:
        import subprocess
        out = subprocess.check_output(
            ["docker", "inspect", "maw-neko", "--format", "{{range .NetworkSettings.Networks}}{{.Gateway}}{{end}}"],
            text=True, stderr=subprocess.DEVNULL
        ).strip()
        if out:
            return out
    except Exception:
        pass
    return "172.17.0.1"

CONTROLLER_URL = os.environ.get("NEKO_CONTROLLER_URL", "http://127.0.0.1:9223")
AUTH_TOKEN = os.environ.get("CONTROLLER_AUTH_TOKEN", "").strip()
GATEWAY_IP = get_docker_gateway()
TEST_PORT = int(os.environ.get("NEKO_TEST_PORT", "9876"))
TEST_BIND_ADDRESS = os.environ.get("NEKO_TEST_BIND_ADDRESS", GATEWAY_IP)

# If token not in env, check .env
if not AUTH_TOKEN:
    env_path = os.path.join(os.path.dirname(__file__), "..", ".env")
    if os.path.exists(env_path):
        with open(env_path) as f:
            for line in f:
                if line.startswith("CONTROLLER_AUTH_TOKEN="):
                    AUTH_TOKEN = line.split("=", 1)[1].strip()
                    break

received_events = []

HTML_PAGE = """<!DOCTYPE html>
<html>
<head><title>Streaming Simulator</title></head>
<body>
<h1>Streaming Simulator</h1>
<div id="status">Connecting...</div>
<div id="output"></div>
<script>
async function startStream() {
  const status = document.getElementById("status");
  const output = document.getElementById("output");
  status.textContent = "Fetching stream...";
  try {
    const res = await fetch("/stream");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const {done, value} = await reader.read();
      if (done) {
        status.textContent = "Done";
        break;
      }
      const text = decoder.decode(value);
      output.textContent += text;
      fetch("/record", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({text: text, time: Date.now()})
      });
    }
  } catch (err) {
    status.textContent = "Error: " + err;
  }
}
startStream();
</script>
</body>
</html>
"""

class TestHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/chat":
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.send_header("Content-Length", str(len(HTML_PAGE)))
            self.end_headers()
            self.wfile.write(HTML_PAGE.encode())
        elif self.path == "/other":
            body = b"<html><head><title>Foreground Tab</title></head><body>Active Tab Content</body></html>"
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif self.path == "/stream":
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            for i in range(1, 11):
                chunk = f"data: chunk {i}\n\n".encode()
                self.wfile.write(chunk)
                self.wfile.flush()
                time.sleep(0.4)
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        if self.path == "/record":
            length = int(self.headers.get("Content-Length", 0))
            data = json.loads(self.rfile.read(length).decode())
            received_events.append(data)
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"status":"ok"}')

    def log_message(self, format, *args):
        pass


def run_test():
    print("=== Synthetic Background Network & Streaming Continuity Benchmark ===")
    print("Notice: Proves synthetic background SSE stream persistence across tab switching.")
    print("Does NOT claim genuine ChatGPT completion detection.\n")

    server = http.server.ThreadingHTTPServer((TEST_BIND_ADDRESS, TEST_PORT), TestHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    time.sleep(0.5)

    headers = {"Content-Type": "application/json"}
    if AUTH_TOKEN:
        headers["Authorization"] = f"Bearer {AUTH_TOKEN}"

    # 1. Create Tab 1
    req = urllib.request.Request(
        f"{CONTROLLER_URL}/tabs",
        data=json.dumps({"url": f"http://{GATEWAY_IP}:{TEST_PORT}/chat"}).encode(),
        headers=headers
    )
    with urllib.request.urlopen(req) as resp:
        tab1 = json.loads(resp.read().decode())
    print(f"[Step 1] Created Tab 1 (Streaming simulator): {tab1['id']}")

    # Wait for initial chunks
    time.sleep(1.0)
    events_before = len(received_events)
    print(f"[Step 2] Chunks received before switch: {events_before}")

    # 2. Create and activate Tab 2
    req = urllib.request.Request(
        f"{CONTROLLER_URL}/tabs",
        data=json.dumps({"url": f"http://{GATEWAY_IP}:{TEST_PORT}/other"}).encode(),
        headers=headers
    )
    with urllib.request.urlopen(req) as resp:
        tab2 = json.loads(resp.read().decode())
    print(f"[Step 3] Created Tab 2: {tab2['id']}")

    req_act = urllib.request.Request(f"{CONTROLLER_URL}/tabs/{tab2['id']}/activate", method="POST", headers=headers)
    with urllib.request.urlopen(req_act) as resp:
        print("[Step 4] Activated Tab 2 (Tab 1 is now occluded in the background)")

    # Wait 4 seconds for remainder of stream to complete in background
    time.sleep(4.0)

    events_after = len(received_events)
    bg_chunks = events_after - events_before
    print(f"[Step 5] Chunks delivered while Tab 1 was in background: {bg_chunks}")
    print(f"[Step 6] Total chunks delivered: {events_after}/10")

    # Clean up tabs
    urllib.request.urlopen(urllib.request.Request(f"{CONTROLLER_URL}/tabs/{tab1['id']}", method="DELETE", headers=headers))
    urllib.request.urlopen(urllib.request.Request(f"{CONTROLLER_URL}/tabs/{tab2['id']}", method="DELETE", headers=headers))

    if bg_chunks >= 6 and events_after >= 10:
        print("\n[RESULT: PASS] Synthetic background network streaming continued without interruption across tab switching.")
        return 0
    else:
        print("\n[RESULT: FAIL] Background stream stalled or lost events.")
        return 1


if __name__ == "__main__":
    sys.exit(run_test())
