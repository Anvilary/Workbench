# MAW Profile Onboarding Guide

This guide describes how to configure, verify, and operate CLI agent profiles in My-Amazing-Workspace (MAW).

---

## What Are Profiles and Why Are Executables Empty by Default?

In MAW, **CLI Profiles** define the execution environments, isolation boundaries, arguments, and credential sandboxes used by autonomous agent sessions (such as OpenAI Codex, Google Antigravity/AGY, and Anthropic Claude Code).

### Why Executables Are Empty by Default
When MAW is first installed, profile entries exist in `agency-profiles.json`, but their `executable` fields are intentionally left blank:

1. **Security & Explicit Consent**: MAW never assumes access to or auto-selects executables from `$PATH`. Executing arbitrary system binaries or invoking native models without explicit review violates least-privilege principles.
2. **Provider Isolation**: Multi-agent development requires distinct execution wrappers (e.g., `codex-0`, `codex-1`, `agy-0` through `agy-5`). Auto-detecting a generic `claude` or `codex` command would risk routing multiple agents into the same credentials and conversation databases.
3. **Preventing Accidental Cloud Costs**: Requiring the user to configure each profile ensures agents are not spawned unintentionally against billable APIs.

Until a profile has its executable configured, its status is marked as unconfigured, and MAW prevents launching agents under that profile.

---

## Profile Onboarding UI Enhancements

In the `feat/maw-launcher-update-onboarding` branch, the UI provides active guidance during first-run setup:

1. **Smart Suggestions (`profile-suggestions.ts`)**:
   - Helper functions `suggestedExecutable(profile)` and `providerSetupNote(profile)` provide contextual recommendations based on the profile's ID and provider type.
2. **Setup Guidance in `AgencyProfileDialog`**:
   - If a profile's executable field is empty, the dialog highlights first-time configuration instructions.
   - The input field displays an intelligent placeholder suggesting the exact expected wrapper (e.g., placeholder text `codex-0` or `agy-2`).
   - Placeholders are hints only and are **never pre-filled** or automatically submitted, preserving explicit user confirmation.
3. **"Profile not configured" Banner in `AgencyWorkspaceView`**:
   - If an unconfigured profile is selected or present in a workspace, an inline warning banner appears:
     > **Profile not configured** — This agent profile needs an executable wrapper path before sessions can be launched.
   - A prominent **Configure** button opens the `AgencyProfileDialog` directly.

---

## Step-by-Step Setup for Each Provider Type

All wrapper binaries on this host are located in `/home/user/.local/bin/` (which is included in `maw.service`'s default `PATH`).

### 1. OpenAI Codex Profiles (`codex-0`, `codex-1`, `codex-3`, etc.)

Each Codex profile represents an isolated workspace root and native session store.

- **Codex 00**:
  - Open Profile Settings.
  - Set **Executable** to: `codex-0`
  - Arguments: leave empty or enter `[]`
  - *Context*: The wrapper sets `CODEX_HOME=~/.codex`.
- **Codex 01**:
  - Set **Executable** to: `codex-1`
  - Arguments: `[]`
  - *Context*: The wrapper sets `CODEX_HOME=~/.codex-ar`.
- **Codex 03**:
  - Set **Executable** to: `codex-3`
  - Arguments: `[]`
  - *Context*: The wrapper sets `CODEX_HOME=~/.codex-3`.

### 2. Google Antigravity / AGY Profiles (`agy-0` through `agy-5`)

AGY profiles require isolated credentials, dedicated D-Bus secret services, and independent user directories.

- **Setup Rule**: Set the executable to `agy-0` through `agy-5` matching the profile number.
  - Profile `agy-0` → Executable: `agy-0` (uses default user Secret Service and `~/.gemini/antigravity-cli`).
  - Profile `agy-1` → Executable: `agy-1` (uses `agy-1-profile-start` helper and isolated storage at `~/.local/share/agy-1-profile/home/.gemini/antigravity-cli`).
  - Profile `agy-2` → Executable: `agy-2`
  - Profile `agy-3` → Executable: `agy-3`
  - Profile `agy-4` → Executable: `agy-4`
  - Profile `agy-5` → Executable: `agy-5`
- **Arguments**: Leave empty or set `[]`.
- **Authentication Mode**: Each wrapper operates in account mode. No secret API keys need to be configured in MAW.

### 3. Anthropic Claude Code (`claude-code`)

- **Setup Rule**:
  - Profile `claude-code` → Set **Executable** to: `claude` (or the absolute path `/home/user/.local/bin/claude`).
- **Arguments**: Leave empty or enter `[]`.
- **Context**: Reuses the user's attested `~/.claude` session configuration and native project-session JSONL store.

---

## Security and Isolation Rules

> [!CAUTION]
> **Never Share Executables Between Profiles**  
> Do NOT set multiple Codex or AGY profiles to point to the same executable or wrapper. Sharing wrappers causes agents to overwrite each other's native session state, poll conflicting logs, and corrupt historical conversation trees.

> [!WARNING]
> **Never Copy Credentials Across Profiles**  
> Each named wrapper (`agy-1`, `agy-2`, etc.) manages its own private keyring helper and isolated XDG storage. Copying credential tokens between profile directories bypasses the host identity attestation model and causes recovery checks to fail closed.

> [!IMPORTANT]
> **Never Export Plaintext API Keys into MAW or Systemd**  
> MAW is designed to execute reviewed local wrappers that handle their own authentication. Do not export `GEMINI_API_KEY`, `OPENAI_API_KEY`, or `ANTHROPIC_API_KEY` into `maw.service` or global systemd environment files.

---

## Verifying Profile Configuration

After saving the executable and arguments in the `AgencyProfileDialog`:

1. **Check UI Status**:
   - The "Profile not configured" banner immediately disappears from `AgencyWorkspaceView`.
   - In the **New CLI** launcher dialog, the profile's `configurationStatus` becomes `'available'`.
   - The **Start Agent** button becomes enabled.
2. **Verify Process Execution**:
   - In your workspace, click **New CLI** and select the configured profile.
   - The PTY will open and invoke the wrapper.
   - Confirm the provider greeting or TUI prompt renders properly.
3. **Verify Configuration File**:
   - Inspect `agency-profiles.json` to confirm persistence:
     ```sh
     cat ~/.config/agent-workbench/agency-profiles.json
     ```
   - Confirm that the `executable` field matches your configured wrapper.

---

## Recovery from a Misconfigured Profile

If a typo is entered (e.g., `agy99` instead of `agy-0`, or a nonexistent binary path):

1. **Symptom**:
   - Attempting to launch an agent tab produces an error message:
     `Executable not found` or `Failed to spawn process`.
2. **Correction Steps**:
   - In the MAW sidebar or header, click on **Settings** / **Profiles** (or click the profile name in the session view).
   - Click **Configure Profile** to reopen `AgencyProfileDialog`.
   - Correct the executable name (e.g., update `agy99` to `agy-0`).
   - Click **Save**.
3. **Inspecting Server Logs**:
   - If process launch continues to fail, run `maw logs` in a terminal to inspect systemd spawn diagnostics:
     ```sh
     maw logs
     ```
   - Ensure the binary exists in `/home/user/.local/bin/` and has executable permissions (`chmod +x`).
