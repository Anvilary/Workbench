#!/usr/bin/env python3
"""
Chromium Process Memory Benchmark.
Measures process count, total RSS, total VSZ, and incremental memory per tab
across 1, 5, and 10 loaded tabs in the MAW Neko runtime.
"""

import json
import os
import subprocess
import sys
import time
import urllib.request

CONTROLLER_URL = os.environ.get("NEKO_CONTROLLER_URL", "http://127.0.0.1:9223")
CONTAINER_NAME = os.environ.get("NEKO_CONTAINER_NAME", "maw-neko")


def get_chromium_memory():
    res = subprocess.run(
        ["docker", "exec", CONTAINER_NAME, "ps", "-eo", "rss,vsz,comm,args"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=True
    )
    total_rss_kb = 0
    total_vsz_kb = 0
    proc_count = 0
    for line in res.stdout.strip().splitlines()[1:]:
        parts = line.strip().split(None, 3)
        if len(parts) >= 4:
            rss = int(parts[0])
            vsz = int(parts[1])
            comm = parts[2]
            args = parts[3]
            if "chromium" in comm or "chromium" in args:
                proc_count += 1
                total_rss_kb += rss
                total_vsz_kb += vsz
    return {
        "proc_count": proc_count,
        "total_rss_mb": round(total_rss_kb / 1024, 2),
        "total_vsz_mb": round(total_vsz_kb / 1024, 2),
    }


def get_tabs():
    req = urllib.request.Request(f"{CONTROLLER_URL}/tabs")
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read().decode())["tabs"]


def create_tab(url):
    req = urllib.request.Request(
        f"{CONTROLLER_URL}/tabs",
        data=json.dumps({"url": url}).encode(),
        headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read().decode())


def close_tab(tab_id):
    req = urllib.request.Request(f"{CONTROLLER_URL}/tabs/{tab_id}", method="DELETE")
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read().decode())


def run_benchmark():
    print("=== MAW Chromium Memory Measurement (1, 5, 10 Tabs) ===")

    # 1. Baseline: 1 Tab
    current_tabs = get_tabs()
    while len(current_tabs) > 1:
        close_tab(current_tabs[0]["id"])
        current_tabs = get_tabs()

    time.sleep(2)
    mem_1 = get_chromium_memory()
    print(f"\n[1 Tab Loaded]")
    print(f"  Chromium Processes: {mem_1['proc_count']}")
    print(f"  Total RSS Memory:   {mem_1['total_rss_mb']} MB")
    print(f"  Total VSZ Memory:   {mem_1['total_vsz_mb']} MB")

    # 2. Scale to 5 Tabs
    created = []
    urls_5 = [
        "https://example.com",
        "https://httpbin.org/html",
        "https://news.ycombinator.com",
        "https://en.wikipedia.org/wiki/Chromium_(web_browser)"
    ]
    for url in urls_5:
        t = create_tab(url)
        created.append(t["id"])
        time.sleep(1)

    time.sleep(3)
    mem_5 = get_chromium_memory()
    inc_1_to_5 = round((mem_5['total_rss_mb'] - mem_1['total_rss_mb']) / 4, 2)
    print(f"\n[5 Tabs Loaded]")
    print(f"  Chromium Processes: {mem_5['proc_count']}")
    print(f"  Total RSS Memory:   {mem_5['total_rss_mb']} MB")
    print(f"  Incremental RSS:    +{round(mem_5['total_rss_mb'] - mem_1['total_rss_mb'], 2)} MB (+{inc_1_to_5} MB/tab)")

    # 3. Scale to 10 Tabs
    urls_10 = [
        "https://www.w3.org/Protocols/rfc2616/rfc2616.html",
        "https://httpbin.org/json",
        "https://httpbin.org/xml",
        "https://example.net",
        "https://example.org"
    ]
    for url in urls_10:
        t = create_tab(url)
        created.append(t["id"])
        time.sleep(1)

    time.sleep(3)
    mem_10 = get_chromium_memory()
    inc_5_to_10 = round((mem_10['total_rss_mb'] - mem_5['total_rss_mb']) / 5, 2)
    inc_1_to_10 = round((mem_10['total_rss_mb'] - mem_1['total_rss_mb']) / 9, 2)
    print(f"\n[10 Tabs Loaded]")
    print(f"  Chromium Processes: {mem_10['proc_count']}")
    print(f"  Total RSS Memory:   {mem_10['total_rss_mb']} MB")
    print(f"  Incremental RSS:    +{round(mem_10['total_rss_mb'] - mem_5['total_rss_mb'], 2)} MB (+{inc_5_to_10} MB/tab)")
    print(f"  Overall Avg/Tab:    +{inc_1_to_10} MB/tab")

    # 4. Cleanup
    for tid in created:
        close_tab(tid)
    time.sleep(2)
    mem_cleanup = get_chromium_memory()
    print(f"\n[Post-Cleanup (1 Tab Remaining)]")
    print(f"  Chromium Processes: {mem_cleanup['proc_count']}")
    print(f"  Total RSS Memory:   {mem_cleanup['total_rss_mb']} MB (released {round(mem_10['total_rss_mb'] - mem_cleanup['total_rss_mb'], 2)} MB)")

    return {
        "1_tab": mem_1,
        "5_tabs": mem_5,
        "10_tabs": mem_10,
        "cleanup": mem_cleanup,
        "avg_incremental_mb_per_tab": inc_1_to_10
    }


if __name__ == "__main__":
    results = run_benchmark()
    output_path = "/tmp/maw_chromium_memory_benchmark.json"
    with open(output_path, "w") as f:
        json.dump(results, f, indent=2)
    print(f"\nBenchmark results saved to {output_path}")
