# Production Ubuntu integration (PR #23 follow-up)

The production entry is **`maw desktop`**, also available as **My Amazing Workspace**
in the Ubuntu application menu after installation. `pnpm desktop` remains the
isolated development prototype and must not be used as the production launcher.

## Installation and activation — owner actions, not performed by the agent

From the reviewed source checkout, on Ubuntu 24.04/26.04 amd64 or arm64 with Node
and pnpm installed:

```sh
pnpm install --frozen-lockfile
sh scripts/maw/install.sh --desktop
```

This builds a versioned `.deb` and explicitly invokes `sudo apt-get install` to
install Electron under `/opt/maw-electron/<version>`, its root-owned SUID sandbox,
required OS libraries and an executable-specific AppArmor user-namespace profile.
It installs the user commands and application-menu entry. It does **not** start,
restart, replace or reconfigure the systemd service, workspace store or Neko.
The package can also be built without installation with
`node scripts/maw/build-desktop-deb.mjs`; CI publishes that artifact.

A legacy serving release still has its old frontend. Installing the runtime alone
cannot turn it into a native client. Until an owner-approved activation, `maw open`
continues to open that legacy release; `maw desktop` reports that it is unavailable.
To test the PR against the existing service, the owner must deliberately stage
and activate the matching application release:

```sh
maw status
maw update --ref origin/experiment/native-chatgpt-electron --allow-unapproved-ref --no-restart
# Inspect the staged result and schedule disruption of live PTYs before proceeding.
maw restart
maw desktop
```

These commands are instructions, not a record of a deployment. After approval and
merge the normal approved-channel `maw update` workflow applies. The existing
restart semantics still terminate server-owned live PTYs and recover eligible
native sessions; this change does not promise PTY survival across a backend restart.

## Runtime, authentication and data

The launcher checks the owner-only, regular readiness file; verifies its PID with
systemd's MainPID; probes its authenticated loopback URL without following redirects;
and resolves the **running** process's release directory and metadata. It launches
that release's desktop app with the version-pinned root-owned Electron runtime.
It never starts another Node backend, reads prototype config, imports CLI profiles
or migrates workspace data. Existing IDs, names, order, URLs, histories and CLI
profiles remain owned by the same service and stores.

The URL is passed through the child environment, never its command line or desktop
file. Error messages are generic and suppress token-bearing errors. Electron
removes the URL environment variable after reading it. The production profile is
`$XDG_DATA_HOME/maw-desktop` (default `~/.local/share/maw-desktop`), owner-only mode
0700. It is distinct from `.native-chatgpt-local/` and all Neko storage. Existing
prototype authentication is not copied: sign in normally once in production.

The bootstrap uses packaged Electron's Node mode so graphical launch does not
require an nvm-managed Node binary on the desktop PATH. It exits after spawning the
window, leaving no extra resident bootstrap process. Closing the window leaves the
systemd service and PTYs running. Re-running `maw desktop` focuses the existing
window; after service activation/restart it reacquires the current URL and reloads
MAW while retaining native ChatGPT pages/session. Only one window owns the profile.

## Update and rollback

The target release's `pnpm build` checks the production runtime whenever the
existing updater's `.maw-candidate` marker is present. Thus even an **older installed
updater** fails its build stage before staging a desktop-requiring release if the
matching root-owned runtime/sandbox is absent or unsafe, or the production launcher installation is incomplete. Installing only a runtime artifact is insufficient. No automatic sudo/install
occurs during update. Install the prerequisite, then retry. Normal development
builds are unaffected.

Runtime packages are version-named and co-installable; do not autoremove an older
runtime required by a retained release. Application code follows the serving
release, not an independent global application version. Existing current/staged/
healthy/previous promotion, failure recovery and `maw rollback` remain unchanged.
A legacy rollback release uses `maw open` and its retained Neko stack; a native
rollback release uses its own desktop code and runtime. No profile is deleted on
rollback. The runtime installer does not overwrite the service unit or environment.

## Verification and limits

Independently verified in this follow-up:

- Built the actual Ubuntu `.deb` and inspected root ownership, safe file modes and
  SUID helper. No user state/service unit is contained in the package.
- Fixture production launch uses the serving release and acquired URL, preserves a
  workspace sentinel, uses a separate private profile and puts no token in argv.
- Command installation is repeatable in temporary paths and preserves state. The desktop-menu installer passed with an apt stub; no real package installation was performed.
- Unsafe/symlink readiness, stale MainPID, and missing-runtime update gate fail closed.
- Existing updater/rollback and isolated real-systemd acceptance results are recorded
  here: 40 updater/rollback tests passed, and the isolated real-systemd crash-loop/recovery test passed (the full repository-build systemd case was skipped). They do not activate the real `maw.service`.
- Typecheck/build/check, backend/frontend, desktop and production packaging fixtures
  run locally. CI additionally builds/uploads the runtime and runs these fixtures.

Not independently verified against the production installation: installing the
package with apt/AppArmor, displaying the owner's existing projects/sessions through
`maw desktop`, provider login and restart persistence in the **new production**
profile, real input/clipboard, sidebar/focus/shortcuts, notifications, browser
fallback after production activation, reboot and representative production memory.
These require owner acceptance after the separately approved activation above.
The earlier prototype evidence in [VALIDATION.md](VALIDATION.md) is not production
acceptance evidence. Its RSS/PSS comparison remains the baseline; no memory reduction
is claimed, and the production workload must be remeasured with `measure-memory.py`.

No merge, production installation, service activation, Neko container operation or
persistent-data deletion was performed for this follow-up.

Local follow-up check results: six production/package fixtures, four desktop policy
checks, Electron lifecycle suite, 154 focused backend/security tests, 26 frontend
tests, typecheck, build and repository checks passed. The existing internal-guide
check remains skipped. CI dispatch/results are tracked on PR #23 rather than inferred
from local checks.

Hosted CI was enabled and dispatched for this follow-up, but GitHub refused to
start jobs because account payments failed or its spending limit needs adjustment.
This is an external CI blocker; no hosted CI pass is claimed. The workflow remains
enabled. No billing/account changes were made.
