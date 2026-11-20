#!/usr/bin/env python3
"""Read-only Linux RSS/PSS process-tree sampling. Never reads command lines or credentials."""
import argparse
import datetime
import json
from pathlib import Path
import re
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--group', action='append', required=True, metavar='LABEL:ROOT_PID')
parser.add_argument('--samples', type=int, default=3)
parser.add_argument('--interval', type=float, default=1)
args = parser.parse_args()
groups = {}
for group in args.group:
    label, pid = group.rsplit(':', 1)
    groups.setdefault(label, set()).add(int(pid))
if not 1 <= args.samples <= 60 or args.interval < 0:
    parser.error('samples must be 1..60 and interval must be non-negative')

def snapshot():
    parents = {}
    for entry in Path('/proc').iterdir():
        if not entry.name.isdigit():
            continue
        try:
            parents[int(entry.name)] = int(re.search(r'^PPid:\s+(\d+)', (entry / 'status').read_text(), re.M)[1])
        except (OSError, TypeError):
            continue
    result = {'utc': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'groups': {}}
    for label, roots in groups.items():
        pids = set(roots)
        while True:
            children = {pid for pid, parent in parents.items() if parent in pids}
            if children <= pids:
                break
            pids |= children
        totals = dict(processes=0, rss_kib=0, pss_kib=0, swap_pss_kib=0, unreadable=0)
        for pid in pids:
            try:
                text = Path(f'/proc/{pid}/smaps_rollup').read_text()
                for field, key in [('Rss', 'rss_kib'), ('Pss', 'pss_kib'), ('SwapPss', 'swap_pss_kib')]:
                    match = re.search(r'^' + field + r':\s+(\d+)', text, re.M)
                    if match:
                        totals[key] += int(match[1])
                totals['processes'] += 1
            except OSError:
                totals['unreadable'] += 1
        result['groups'][label] = totals
    return result

samples = []
for index in range(args.samples):
    if index:
        time.sleep(args.interval)
    samples.append(snapshot())
print(json.dumps({'method': 'sum of smaps_rollup values over each unique process tree; workloads must be described separately', 'samples': samples}, indent=2))
