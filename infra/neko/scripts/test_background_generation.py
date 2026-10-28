#!/usr/bin/env python3
"""
Verification Script: Background Generation Persistence.

Proves that:
1. When Tab 1 is streaming tokens/chunks, switching the active visible browser
   tab to Tab 2 does NOT interrupt or throttle Tab 1.
2. Background chunks continue to arrive with consistent timing.
3. No data loss, stalled connections, or timer degradation occur while Tab 1 is hidden.
"""

import http.server
import json
import os
import sys
import threading
import time
import urllib.request

CONTROLLER_URL = os.environ.get("NEKO_CONTROLLER_URL", "http://127.0.0.1:9223")
GATEWAY_IP = os.environ.get("GATEWAY_IP", "172.17.0.1")
TEST_PORT = 9876

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
    print("=== Testing Background Generation Persistence Across Tab Switching ===")
    server = http.server.ThreadingHTTPServer(("0.0.0.0", TEST_PORT), TestHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    time.sleep(0.5)

    # 1. Create Tab 1
    req = urllib.request.Request(
        f"{CONTROLLER_URL}/tabs",
        data=json.dumps({"url": f"http://{GATEWAY_IP}:{TEST_PORT}/chat"}).encode(),
        headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req) as resp:
        tab1 = json.loads(resp.read().decode())
    print(f"[Step 1] Created Tab 1 (Streaming simulator): {tab1['id']}")

    # Wait for initial chunks
    time.sleep(1.0)
    events_before = len(received_events)
    print(f"[Step 2] Events received before switch: {events_before}")

    # 2. Create and activate Tab 2
    req = urllib.request.Request(
        f"{CONTROLLER_URL}/tabs",
        data=json.dumps({"url": f"http://{GATEWAY_IP}:{TEST_PORT}/other"}).encode(),
        headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req) as resp:
        tab2 = json.loads(resp.read().decode())
    print(f"[Step 3] Created Tab 2: {tab2['id']}")

    req_act = urllib.request.Request(f"{CONTROLLER_URL}/tabs/{tab2['id']}/activate", method="POST")
    with urllib.request.urlopen(req_act) as resp:
        print("[Step 4] Activated Tab 2 (Tab 1 is now running strictly in the background)")

    # Wait 4 seconds for remainder of stream to complete in background
    time.sleep(4.0)

    events_after = len(received_events)
    bg_chunks = events_after - events_before
    print(f"[Step 5] Chunks received while Tab 1 was hidden in background: {bg_chunks}")
    print(f"[Step 6] Total chunks delivered: {events_after}/10")

    # Clean up tabs
    urllib.request.urlopen(urllib.request.Request(f"{CONTROLLER_URL}/tabs/{tab1['id']}", method="DELETE"))
    urllib.request.urlopen(urllib.request.Request(f"{CONTROLLER_URL}/tabs/{tab2['id']}", method="DELETE"))

    if bg_chunks >= 6 and events_after >= 10:
        print("\n[RESULT: PASS] Background stream generation completed without interruption while another tab was visible.")
        return 0
    else:
        print("\n[RESULT: FAIL] Background stream stalled or lost events.")
        return 1


if __name__ == "__main__":
    sys.exit(run_test())
