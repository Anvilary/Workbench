<img width="1920" height="640" alt="workbench-readme-banner-1920x640" src="https://github.com/user-attachments/assets/190830f4-2644-45a5-9707-c3c7007047d2" />

# Anvilary Workbench

**Local-first desktop workstation for autonomous AI coding agents.** Organizes projects, persistent terminals, installed coding CLIs, and native Chromium web tabs in a supervised, fluid multi-pane desktop interface.

An open-source product from [Anvilary Tools](https://anvilary.tools).

[![CI](https://github.com/Anvilary/Workbench/actions/workflows/ci.yml/badge.svg)](https://github.com/Anvilary/Workbench/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Electron](https://img.shields.io/badge/electron-45.2.0-blue.svg)](https://www.electronjs.org/)
[![React](https://img.shields.io/badge/react-19.0.0-61dafb.svg)](https://react.dev/)

**English** · [Español](README.es.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [Português (Brasil)](README.pt-BR.md) · [Русский](README.ru.md) · [한국어](README.ko.md) · [Français](README.fr.md) · [Deutsch](README.de.md)

---

## Product Demonstration

Watch the complete **Project Organization -> Persistent Terminal -> Coding Agent -> Split Panes -> Native Chromium Web Tabs** workflow in action (high-definition desktop recording, 93 seconds):

[![Anvilary Workbench Official Demonstration](docs/media/workbench-demo.webp)](https://github.com/Anvilary/Workbench/issues/32)

> 📹 **[Click here to watch the full HD demonstration video (MP4, 2.2 MB)](https://github.com/Anvilary/Workbench/issues/32)**

<details>
<summary><strong>Video Scene Breakdown & Demonstration Transcript</strong></summary>

1. **Scene 1: Initial Viewport & Single-Pane Workspace (0:00 - 0:08)**: Opening the clean dark desktop interface with Anvilary orange accents, displaying the synthetic project tree in the sidebar and an uncluttered single full-width pane.
2. **Scene 2: Project Organization & Workspace Navigation (0:08 - 0:20)**: Navigating fluidly between multiple projects (Demo Application, Backend Service, and Docs & Guides) in the sidebar navigation tree.
3. **Scene 3: Supervised Persistent Terminal & Genuine Coding CLI (0:20 - 0:38)**: Launching a persistent terminal session, executing unit tests (`npm test` 3/3 passing), and verifying the installed Codex AI coding agent (`codex --version` and `codex --help`).
4. **Scene 4: Fluid Multi-Pane Split & Divider Resizing (0:38 - 0:50)**: Splitting the workspace vertically into balanced 50% / 50% columns, followed by interactive split divider dragging.
5. **Scene 5: Native Chromium Web Integration (0:50 - 1:04)**: Opening the Destination Picker, inspecting Favorites and Search Engines, and loading public technical documentation (`https://docs.anvilary.dev`) inside an isolated native Chromium view.
6. **Scene 6: Find in Page & Native Scroll Navigation (1:04 - 1:12)**: Invoking the in-page search bar (`Ctrl+F`), navigating live occurrences with keyboard navigation, and native view auto-scrolling.
7. **Scene 7: Application Settings & Resource Monitoring (1:12 - 1:25)**: Accessing the application shell menu and inspecting General, Terminal, Browser, Agents, and Usage/Monitoring telemetry.
8. **Scene 8: Final Balanced Workspace Composition & Outro (1:25 - 1:33)**: Returning to the balanced dual-pane layout displaying coding CLI output on the left and documentation on the right for a deliberate, visible 8-second closing composition.

*Note: All projects, directory paths, and terminal commands shown in the demonstration use synthetic fixtures and sanitized test data.*
</details>

---

## Why Workbench?

- **Persistent PTY Daemon**: Terminal sessions are supervised by an independent background daemon (`maw-ptyd`). Long-running builds, autonomous coding agents, and test runners survive application updates, desktop window reloads, and desktop restarts without losing state or scrollback history.
- **Zero Credential Access**: Workbench starts the coding CLIs you already have installed and authenticated locally (such as `codex`, `claude`, `opencode`, or `agy`). It never intercepts or stores your personal API keys, passwords, or authentication tokens.
- **Native Chromium Web Tabs**: Native Chromium `WebContentsView` instances embed documentation, web applications, and AI chat interfaces directly into your workspace panes with zero iframe styling quirks and full hardware acceleration.
- **Fluid Multi-Pane Split Layouts**: Split your workspace horizontally or vertically with fluid divider resizing, drag-and-drop tab organization, and independent pane focus synchronization.
- **Local-First Architecture**: Your code, logs, session data, and workspace layout state remain strictly on your local machine. No cloud sync, no forced accounts, and no telemetry tracking your keystrokes.

---

## Quick Start

### Prerequisites

- **Linux / Ubuntu**: Desktop environment (X11 or Wayland) with Node.js 20+ and pnpm installed.
- **AI Coding CLIs** (optional): Install your preferred agents (`claude`, `codex`, `opencode`, or `agy`) on your PATH.

### Installation and Launch

```bash
# Clone the repository
git clone https://github.com/Anvilary/Workbench.git
cd Workbench

# Install dependencies
pnpm install

# Build all packages
pnpm build

# Launch the desktop workstation
pnpm desktop
```

---

## Key Features

### Persistent Terminals and Coding Agents
- **Supervised Processes**: The dedicated `maw-ptyd` daemon supervises pseudo-terminals across restarts.
- **Scrollback and Search**: High-performance xterm.js terminal integration with incremental text search.
- **Direct CLI Execution**: Run any standard developer CLI (`npm`, `cargo`, `git`) alongside autonomous AI coding tools.

### Fluid Multi-Pane Layouts
- **Dynamic Tree Splitting**: Split any pane horizontally or vertically into balanced sub-panes.
- **Smooth Divider Resizing**: Interactive divider bars with minimum boundary protection.
- **Tab Drag and Drop**: Reorder tabs within a pane or drag tabs between distinct panes.

### Native Chromium Web Tabs
- **Direct Web Navigation**: Open documentation sites, local web servers (`http://localhost:*`), and web tools.
- **Destination Picker**: Quick access to developer favorites, search engines, and arbitrary URLs.
- **Native Find in Page**: Chromium-powered in-page search with occurrence counters, keyboard shortcuts, and smooth viewport auto-scrolling.

### Project and Workspace Organization
- **Hierarchical Sidebar**: Organize multiple projects, each containing isolated working folders and Git worktrees.
- **Status Badges**: Visual indicators displaying active sessions and pane activity.
- **Workspace Navigation**: Instant switching between project workspaces while background terminals continue executing.

### Remote Access over SSH
Leave Workbench running on one computer and access it from another device on your local network through a secure SSH tunnel. The application remains bound strictly to loopback (`127.0.0.1`).

1. Enable the OpenSSH server on your host machine:

- **Windows 10/11** (PowerShell as administrator):
  ```powershell
  Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
  Start-Service sshd
  Set-Service -Name sshd -StartupType Automatic
  ```

- **Linux** (Debian / Ubuntu):
  ```bash
  sudo apt install openssh-server
  sudo systemctl enable --now ssh
  ```

2. Enable remote access in Workbench settings and connect via SSH port forwarding (`ssh -N -L 24837:127.0.0.1:24837 user@host`).

---

## Local-First Architecture and Privacy

| Boundary Area | Isolation Mechanism | Verification Detail |
|---|---|---|
| **Terminal Processes** | Supervised under local PTY daemon socket | Process execution runs under your standard local user permissions; no network proxies. |
| **Browser Profiles** | Partitioned Electron storage (`persist:maw-browser`) | Web tabs are isolated from desktop internals with strict Content Security Policy. |
| **Session Metadata** | Atomic JSON persistence in `~/.config/agent-workbench` | Workspaces, layout trees, and tab states are saved locally with automatic `.bak` backups. |
| **Network Requests** | Direct client connections only | Workbench makes zero external phone-home calls and collects no telemetry without consent. |

---

## Technology Stack

- **Desktop Shell**: [Electron 45](https://www.electronjs.org/) (Chromium 134, Node.js integration, WebContentsView)
- **Frontend UI**: [React 19](https://react.dev/), [TypeScript](https://www.typescriptlang.org/), [Tailwind CSS](https://tailwindcss.com/)
- **Terminal Rendering**: [xterm.js](https://xtermjs.org/) with WebGL addon and search addon
- **Process Supervision**: Dedicated Unix domain socket daemon (`maw-ptyd`) with node-pty
- **Layout Engine**: Custom binary split-tree reducer with `@dnd-kit` drag-and-drop orchestration
- **Build System**: [Turborepo](https://turbo.build/), [Vite](https://vite.dev/), [tsup](https://tsup.egoist.dev/)

---

## Local Development

### Verification Commands

```bash
# Type check all packages
pnpm typecheck

# Code formatting and linting
pnpm lint

# Unit test suites across packages
pnpm test

# Build all web and server packages
pnpm build
```

---

## Documentation Directory

- [Architecture v2 Specification](docs/architecture/architecture-v2.md): Modular design, dependency rules, and IPC contracts.
- [Browser Tabs Architecture](docs/maw/BROWSER-TABS.md): WebContentsView lifecycle, native focus coordination, and find-in-page.
- [Update and Rollback Guide](docs/maw/UPDATE-ROLLBACK.md): Atomic release staging, symlink promotion, and zero-downtime rollback.

---

## Known Boundaries and Honest Limitations

- **Desktop Platform Support**: The desktop workstation currently targets Linux (Ubuntu / Debian with X11 or Wayland). Native Windows and macOS desktop packages are roadmap targets.
- **WebContentsView Z-Ordering**: Native Chromium browser views are rendered by Electron's native compositor. HTML modal overlays within Workbench use coordinate masking when hovering over active web views.
- **Daemon Socket Isolation**: `maw-ptyd` relies on local Unix domain socket permissions (`0700`) within `$XDG_RUNTIME_DIR`. Multi-user shared Linux systems require standard filesystem permission hygiene.

---

## License and Attribution

Anvilary Workbench is open-source software licensed under the **[MIT License](LICENSE)**.

### Provenance and Upstream Attribution

Workbench builds upon and extends the foundational architecture of Agent Workbench. We gratefully acknowledge the original authors and contributors of the Agent Workbench project:

- Copyright (c) 2024-2025 Christian Velasquez and Agent Workbench contributors.
- Copyright (c) 2026 Alexandre Teixeira and Anvilary contributors.

See [LICENSE](LICENSE) for the full text of the MIT license.
