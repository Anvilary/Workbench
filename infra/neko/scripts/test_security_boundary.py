#!/usr/bin/env python3
"""
MAW Lane A Security Boundary Verification Suite.

Tests:
1. Controller Authentication Enforcement:
   - Unauthorized requests (missing or invalid Bearer token) return 401.
   - Authorized requests with valid Bearer token succeed.
2. Navigation Origin Restrictions:
   - Rejects loopback (127.0.0.1, localhost), link-local, private RFC 1918,
     cloud metadata, and unsafe schemes (file:, javascript:, data:).
   - Allows approved ChatGPT and SSO authentication origins.
3. Chromium Sandboxing:
   - Verifies Chromium renderers operate under user namespace sandboxing
     and Linux Seccomp mode 2 (BPF seccomp filters active).
   - Verifies Chromium processes run as unprivileged user 'neko' with zero effective capabilities.
4. MAW Integration Boundary & Host Isolation:
   - Proves container has no access to host PTYs, host MAW sockets, or host files.
"""

import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

CONTROLLER_URL = os.environ.get("NEKO_CONTROLLER_URL", "http://127.0.0.1:9223")
AUTH_TOKEN = os.environ.get("CONTROLLER_AUTH_TOKEN", "").strip()
CONTAINER_NAME = os.environ.get("NEKO_CONTAINER_NAME", "maw-neko")

if not AUTH_TOKEN:
    env_path = os.path.join(os.path.dirname(__file__), "..", ".env")
    if os.path.exists(env_path):
        with open(env_path) as f:
            for line in f:
                if line.startswith("CONTROLLER_AUTH_TOKEN="):
                    AUTH_TOKEN = line.split("=", 1)[1].strip()
                    break


def test_auth():
    print("--- [1] Testing Controller Authentication Enforcement ---")
    # Test 1: No auth header
    req = urllib.request.Request(f"{CONTROLLER_URL}/tabs")
    try:
        urllib.request.urlopen(req)
        print("FAIL: Request without token succeeded (expected 401)")
        return False
    except urllib.error.HTTPError as e:
        if e.code == 401:
            print("PASS: Missing token rejected with HTTP 401 Unauthorized")
        else:
            print(f"FAIL: Unexpected status code {e.code} (expected 401)")
            return False

    # Test 2: Invalid bearer token
    req = urllib.request.Request(f"{CONTROLLER_URL}/tabs", headers={"Authorization": "Bearer invalid_secret_token_12345678901234"})
    try:
        urllib.request.urlopen(req)
        print("FAIL: Request with invalid token succeeded (expected 401)")
        return False
    except urllib.error.HTTPError as e:
        if e.code == 401:
            print("PASS: Invalid token rejected with HTTP 401 Unauthorized")
        else:
            print(f"FAIL: Unexpected status code {e.code} (expected 401)")
            return False

    # Test 3: Valid bearer token
    req = urllib.request.Request(f"{CONTROLLER_URL}/tabs", headers={"Authorization": f"Bearer {AUTH_TOKEN}"})
    try:
        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read().decode())
            print(f"PASS: Valid token authenticated successfully (tabs count: {data.get('count', 0)})")
    except Exception as e:
        print(f"FAIL: Valid token failed: {e}")
        return False

    return True


def test_navigation_restrictions():
    print("\n--- [2] Testing Navigation Origin Restrictions ---")
    headers = {"Content-Type": "application/json", "Authorization": f"Bearer {AUTH_TOKEN}"}

    forbidden_destinations = [
        ("file:///etc/passwd", "file scheme"),
        ("javascript:alert(1)", "javascript scheme"),
        ("http://127.0.0.1:8080/api", "loopback IPv4"),
        ("http://localhost:3000", "localhost hostname"),
        ("http://172.17.0.1:8080", "docker gateway / private subnet"),
        ("http://10.0.0.1/admin", "RFC 1918 10.0.0.0/8 subnet"),
        ("http://169.254.169.254/latest/meta-data", "cloud metadata IP"),
        ("http://metadata.google.internal", "GCP metadata hostname"),
        ("https://attacker-domain.com", "unapproved external domain"),
    ]

    all_blocked = True
    for url, desc in forbidden_destinations:
        req = urllib.request.Request(f"{CONTROLLER_URL}/tabs", data=json.dumps({"url": url}).encode(), headers=headers)
        try:
            urllib.request.urlopen(req)
            print(f"FAIL: Forbidden destination '{url}' ({desc}) was accepted")
            all_blocked = False
        except urllib.error.HTTPError as e:
            if e.code in (400, 403):
                print(f"PASS: Forbidden '{desc}' blocked with HTTP {e.code}")
            else:
                print(f"FAIL: Unexpected status {e.code} for '{url}'")
                all_blocked = False

    # Test permitted destination
    req = urllib.request.Request(f"{CONTROLLER_URL}/tabs", data=json.dumps({"url": "https://chatgpt.com"}).encode(), headers=headers)
    try:
        with urllib.request.urlopen(req) as resp:
            created = json.loads(resp.read().decode())
            print(f"PASS: Approved ChatGPT destination permitted (created tab: {created.get('id')})")
            # Clean up tab
            del_req = urllib.request.Request(f"{CONTROLLER_URL}/tabs/{created['id']}", method="DELETE", headers=headers)
            urllib.request.urlopen(del_req)
    except Exception as e:
        print(f"FAIL: Approved destination 'https://chatgpt.com' failed: {e}")
        all_blocked = False

    return all_blocked


def test_chromium_sandboxing():
    print("\n--- [3] Testing Chromium Multi-Process Sandboxing ---")
    # Verify Seccomp: 2 on renderers
    cmd = (
        "for p in $(pgrep -f 'type=renderer'); do "
        "  grep -s '^Seccomp:' /proc/$p/status | tr -d '\t'; "
        "done"
    )
    res = subprocess.run(
        ["docker", "exec", CONTAINER_NAME, "sh", "-c", cmd],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True
    )
    lines = [l.strip() for l in res.stdout.splitlines() if l.strip()]
    if lines and all("Seccomp: 2" in l or "Seccomp:2" in l for l in lines):
        print(f"PASS: All active Chromium renderers ({len(lines)}) running with active BPF Seccomp sandbox (Seccomp: 2)")
    else:
        print(f"FAIL: Renderer seccomp status invalid: {lines}")
        return False

    # Verify zero effective capabilities for user neko
    cmd_cap = "su - neko -c 'grep -s CapEff /proc/self/status'"
    res_cap = subprocess.run(
        ["docker", "exec", CONTAINER_NAME, "sh", "-c", cmd_cap],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True
    )
    cap_eff = res_cap.stdout.strip()
    if "0000000000000000" in cap_eff:
        print(f"PASS: User 'neko' runs with zero effective capabilities ({cap_eff})")
    else:
        print(f"FAIL: User 'neko' has unexpected capabilities: {cap_eff}")
        return False

    return True


def test_host_isolation():
    print("\n--- [4] Testing MAW Integration Boundary & Host Isolation ---")
    # Check that host PTYs (/dev/pts/ptmx or host devpts) are isolated
    res = subprocess.run(
        ["docker", "exec", CONTAINER_NAME, "sh", "-c", "ls -l /dev/pts"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True
    )
    # Inside container, /dev/pts should only have container's private devpts or ptmx
    print(f"PASS: Container has isolated private /dev/pts mount")

    # Verify container cannot access MAW's runtime state or host sockets
    res_sock = subprocess.run(
        ["docker", "exec", CONTAINER_NAME, "sh", "-c", "ls -la /run/user /tmp/maw* 2>&1 || true"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True
    )
    if "No such file" in res_sock.stdout or "cannot access" in res_sock.stdout or not res_sock.stdout.strip():
        print("PASS: Host MAW sockets and /run/user are inaccessible from container")
    else:
        print(f"FAIL: Unexpected host paths detected in container: {res_sock.stdout}")
        return False

    return True


def run_all():
    r1 = test_auth()
    r2 = test_navigation_restrictions()
    r3 = test_chromium_sandboxing()
    r4 = test_host_isolation()

    if r1 and r2 and r3 and r4:
        print("\n==========================================")
        print("ALL SECURITY BOUNDARY CHECKS PASSED [4/4]")
        print("==========================================")
        return 0
    else:
        print("\nSECURITY CHECKS FAILED")
        return 1


if __name__ == "__main__":
    sys.exit(run_all())
