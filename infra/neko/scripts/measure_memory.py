#!/usr/bin/env python3
"""
Chromium Process Memory Benchmark: PSS and RSS Measurement.

Measures both Proportional Set Size (PSS) and Resident Set Size (RSS) across
1, 5, and 10 loaded tabs.
PSS accounts for shared memory pages (e.g. V8 engine, libc, shared Chromium libraries)
by dividing them proportionally among all processes sharing them, providing the exact
true physical memory consumption.
"""

import json
import os
import subprocess
import sys
import time
import urllib.request

CONTROLLER_URL = os.environ.get("NEKO_CONTROLLER_URL", "http://127.0.0.1:9223")
AUTH_TOKEN = os.environ.get("CONTROLLER_AUTH_TOKEN", "").strip()
CONTAINER_NAME = os.environ.get("NEKO_CONTAINER_NAME", "maw-neko")

# Try reading from .env if AUTH_TOKEN is not in env
if not AUTH_TOKEN:
    env_path = os.path.join(os.path.dirname(__file__), "..", ".env")
    if os.path.exists(env_path):
        with open(env_path) as f:
            for line in f:
                if line.startswith("CONTROLLER_AUTH_TOKEN="):
                    AUTH_TOKEN = line.split("=", 1)[1].strip()
                    break


def get_headers():
    headers = {"Content-Type": "application/json"}
    if AUTH_TOKEN:
        headers["Authorization"] = f"Bearer {AUTH_TOKEN}"
    return headers


def get_chromium_memory_smaps():
    """Reads PSS and RSS from /proc/<pid>/smaps_rollup inside the container."""
    cmd = (
        "for p in $(pgrep -f 'chromium'); do "
        "  if [ -f /proc/$p/smaps_rollup ]; then "
        "    echo -n \"$p \"; "
        "    grep -E '^(Pss|Rss):' /proc/$p/smaps_rollup | tr '\n' ' '; "
        "    echo ''; "
        "  fi; "
        "done"
    )
    res = subprocess.run(
        ["docker", "exec", CONTAINER_NAME, "sh", "-c", cmd],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=True
    )

    total_pss_kb = 0
    total_rss_kb = 0
    proc_count = 0

    for line in res.stdout.strip().splitlines():
        # Example line: 16 Pss: 12345 kB Rss: 23456 kB
        parts = line.split()
        if len(parts) >= 5:
            proc_count += 1
            try:
                # Find Pss and Rss indices
                for i in range(len(parts) - 1):
                    if parts[i] == "Pss:":
                        total_pss_kb += int(parts[i + 1])
                    elif parts[i] == "Rss:":
                        total_rss_kb += int(parts[i + 1])
            except (ValueError, IndexError):
                pass

    return {
        "proc_count": proc_count,
        "total_pss_mb": round(total_pss_kb / 1024, 2),
        "total_rss_mb": round(total_rss_kb / 1024, 2),
    }


def get_tabs():
    req = urllib.request.Request(f"{CONTROLLER_URL}/tabs", headers=get_headers())
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read().decode())["tabs"]


def create_tab(url):
    req = urllib.request.Request(
        f"{CONTROLLER_URL}/tabs",
        data=json.dumps({"url": url}).encode(),
        headers=get_headers()
    )
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read().decode())


def close_tab(tab_id):
    req = urllib.request.Request(f"{CONTROLLER_URL}/tabs/{tab_id}", method="DELETE", headers=get_headers())
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read().decode())


def run_benchmark():
    print("=== MAW Chromium Memory Benchmark (PSS & RSS Across 1, 5, 10 Tabs) ===")

    # 1. Baseline: 1 Tab
    current_tabs = get_tabs()
    while len(current_tabs) > 1:
        close_tab(current_tabs[0]["id"])
        current_tabs = get_tabs()

    time.sleep(2)
    mem_1 = get_chromium_memory_smaps()
    print(f"\n[1 Tab Loaded]")
    print(f"  Chromium Processes: {mem_1['proc_count']}")
    print(f"  Total PSS Memory:   {mem_1['total_pss_mb']} MB (Exact shared-adjusted consumption)")
    print(f"  Total RSS Memory:   {mem_1['total_rss_mb']} MB (Raw unadjusted resident pages)")

    # 2. Scale to 5 Tabs
    created = []
    # Use permitted destinations
    urls_5 = [
        "https://chatgpt.com",
        "https://openai.com",
        "https://accounts.google.com",
        "https://login.live.com",
    ]
    for url in urls_5:
        try:
            t = create_tab(url)
            created.append(t["id"])
        except Exception as e:
            print(f"Tab creation note: {e}")
        time.sleep(1)

    time.sleep(3)
    mem_5 = get_chromium_memory_smaps()
    inc_pss_1_to_5 = round((mem_5['total_pss_mb'] - mem_1['total_pss_mb']) / max(len(created), 1), 2)
    inc_rss_1_to_5 = round((mem_5['total_rss_mb'] - mem_1['total_rss_mb']) / max(len(created), 1), 2)
    print(f"\n[5 Tabs Loaded]")
    print(f"  Chromium Processes: {mem_5['proc_count']}")
    print(f"  Total PSS Memory:   {mem_5['total_pss_mb']} MB (+{round(mem_5['total_pss_mb'] - mem_1['total_pss_mb'], 2)} MB, +{inc_pss_1_to_5} MB/tab PSS)")
    print(f"  Total RSS Memory:   {mem_5['total_rss_mb']} MB (+{round(mem_5['total_rss_mb'] - mem_1['total_rss_mb'], 2)} MB, +{inc_rss_1_to_5} MB/tab RSS)")

    # 3. Scale to 10 Tabs
    more_urls = [
        "https://chatgpt.com",
        "https://openai.com",
        "https://appleid.apple.com",
        "https://accounts.google.com",
        "https://login.microsoftonline.com",
    ]
    for url in more_urls:
        try:
            t = create_tab(url)
            created.append(t["id"])
        except Exception as e:
            print(f"Tab creation note: {e}")
        time.sleep(1)

    time.sleep(3)
    mem_10 = get_chromium_memory_smaps()
    inc_pss_5_to_10 = round((mem_10['total_pss_mb'] - mem_5['total_pss_mb']) / 5, 2)
    inc_rss_5_to_10 = round((mem_10['total_rss_mb'] - mem_5['total_rss_mb']) / 5, 2)
    overall_pss_per_tab = round((mem_10['total_pss_mb'] - mem_1['total_pss_mb']) / len(created), 2)
    overall_rss_per_tab = round((mem_10['total_rss_mb'] - mem_1['total_rss_mb']) / len(created), 2)
    print(f"\n[10 Tabs Loaded]")
    print(f"  Chromium Processes: {mem_10['proc_count']}")
    print(f"  Total PSS Memory:   {mem_10['total_pss_mb']} MB (+{round(mem_10['total_pss_mb'] - mem_5['total_pss_mb'], 2)} MB, +{inc_pss_5_to_10} MB/tab PSS)")
    print(f"  Total RSS Memory:   {mem_10['total_rss_mb']} MB (+{round(mem_10['total_rss_mb'] - mem_5['total_rss_mb'], 2)} MB, +{inc_rss_5_to_10} MB/tab RSS)")
    print(f"  Overall Avg/Tab:    +{overall_pss_per_tab} MB PSS/tab (+{overall_rss_per_tab} MB RSS/tab)")

    # 4. Cleanup
    for tid in created:
        try:
            close_tab(tid)
        except Exception:
            pass
    time.sleep(2)
    mem_cleanup = get_chromium_memory_smaps()
    print(f"\n[Post-Cleanup (1 Tab Remaining)]")
    print(f"  Chromium Processes: {mem_cleanup['proc_count']}")
    print(f"  Total PSS Memory:   {mem_cleanup['total_pss_mb']} MB (released {round(mem_10['total_pss_mb'] - mem_cleanup['total_pss_mb'], 2)} MB)")
    print(f"  Total RSS Memory:   {mem_cleanup['total_rss_mb']} MB (released {round(mem_10['total_rss_mb'] - mem_cleanup['total_rss_mb'], 2)} MB)")

    return {
        "1_tab": mem_1,
        "5_tabs": mem_5,
        "10_tabs": mem_10,
        "cleanup": mem_cleanup,
        "avg_incremental_pss_mb_per_tab": overall_pss_per_tab,
        "avg_incremental_rss_mb_per_tab": overall_rss_per_tab,
    }


if __name__ == "__main__":
    results = run_benchmark()
    output_path = "/tmp/maw_chromium_memory_benchmark_pss.json"
    with open(output_path, "w") as f:
        json.dump(results, f, indent=2)
    print(f"\nBenchmark results saved to {output_path}")
