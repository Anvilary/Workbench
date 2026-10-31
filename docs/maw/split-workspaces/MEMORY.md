# Memory footprint

Measured on 2026-10-31 on Linux x86_64 with Electron 45.2.0, the Chromium sandbox enabled, and Node v24.22.0. The window content size was 1440×900 on X11. The Agency server ran `tsx src/index.ts --prod`, so the figure is the compiled web client and does not include Vite. ChatGPT views were real `chatgpt.com` pages on a fresh profile (signed out), with `loading === false`. Exact KiB samples and per-process rows are in `memory-evidence.json`.

The run used a temporary `HOME`, `XDG_*`, and `MAW_DESKTOP_DATA_DIR`. The production profile and `~/.config/agent-workbench` were left untouched (directory mtime stayed `1793411051`).

An earlier revision of this note reported about 173 MB RSS, about 3.8 MB of heap, and a total footprint under 200 MB. Those figures described one process. This revision replaces them with the full process trees below.

## How the numbers were taken

RSS is the sum of `VmRSS` from `/proc/<pid>/status` for every descendant. Every sampled process exposed `VmRSS` (`rssMissing` was 0). PSS is the sum of `Pss` from `smaps_rollup` only where that file was readable. Sandboxed children refused `smaps_rollup`. Their RSS is in the tree total, and they are excluded from PSS.

Summed RSS counts a shared page in each process that maps it, so it is larger than unique memory. The partial PSS stays near 216 MiB while ChatGPT views are added, because the added resident memory is in the unreadable children. Partial PSS is a subset. The Electron tree and the backend tree are reported separately.

The Electron main heap is `process.memoryUsage()` in the Electron main process, taken once after the three RSS samples. Backend V8 heap was not instrumented. Swap was 0 KiB.

The `chrome-sandbox` child exposed `--type=zygote`. Other sandboxed children had no `--type` on a readable command line, so this note does not label individual PIDs as renderer, GPU, or utility. Every child is inside the RSS sum. Each additional visible ChatGPT view coincided with one more sandboxed `electron` process in that unreadable set (4 processes at one view, 5 at two, 7 at four).

## Electron process tree

Three samples, one second apart, after the views were on screen.

| Visible ChatGPT views | Processes | RSS KiB (three samples) | PSS KiB, readable processes only | Main-process RSS bytes | Main-process V8 `heapUsed` bytes |
| :--- | ---: | :--- | :--- | ---: | ---: |
| 1 | 9 | 947768, 949624, 951076 | 221297, 221773, 221781 (4 of 9 excluded) | 189677568 | 4162984 |
| 2 | 10 | 1162168, 1163984, 1165836 | 219103, 219135, 219131 (5 of 10 excluded) | 193695744 | 4751684 |
| 4 | 12 | 1607332, 1603960, 1604124 | 221401, 221226, 221246 (7 of 12 excluded) | 201543680 | 4198400 |

In MiB (KiB / 1024, bytes / 1048576), the last sample is:

| Visible ChatGPT views | Electron tree RSS | Unreadable-child RSS inside that total | Main-process RSS | Main-process V8 heap |
| :--- | ---: | ---: | ---: | ---: |
| 1 | 928.8 MiB | 367.3 MiB | 180.9 MiB | 4.0 MiB |
| 2 | 1138.5 MiB | 571.8 MiB | 184.7 MiB | 4.5 MiB |
| 4 | 1566.5 MiB | 987.9 MiB | 192.2 MiB | 4.0 MiB |

From one visible ChatGPT view to four, Electron tree RSS rose from 951076 KiB to 1604124 KiB on the last samples (637.7 MiB). The main process V8 heap stayed near 4 MiB.

## Backend process tree

Eight processes, and `smaps_rollup` was readable for all of them. The tree is three Node processes (`MainThread`), one `pnpm-native` process, `sh`, two `bash` processes, and the idle `python3 hold.py` PTY workload (12264 KiB RSS, 6135 KiB PSS).

| Visible ChatGPT views | RSS KiB (three samples) | PSS KiB (complete) |
| :--- | :--- | :--- |
| 1 | 385916, 385960, 386016 | 227287, 227337, 227393 |
| 2 | 386600, 386660, 386692 | 227971, 228031, 228068 |
| 4 | 387520, 387600, 387660 | 228895, 228975, 229035 |

Backend RSS stayed near 377–379 MiB and PSS near 222–224 MiB while the ChatGPT views were added.

## What stayed resident across the same run

The shell that printed the scrollback sample kept the same PID across tab switches, a split, divider drags, growth to four panes, and the return to that terminal. The visible terminal still held the first and last sample lines at `viewportY` 0, and its column count changed with the pane width (154, then 34 after the four-pane layout). Four `chatgpt.com` views stayed attached through a divider drag, with no capture backdrop left behind after the New CLI dialog, the notification dropdown, or four rapid notification toggles.
