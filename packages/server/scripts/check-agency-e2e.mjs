/**
 * Automated End-to-End Acceptance Test for Agency-UI (Phase 7)
 *
 * Checks acceptance paths against a real running server process:
 *  1. Server starts on localhost with existing authentication
 *  2. Unknown token and foreign Origin are rejected
 *  3. Browser loads the integrated Agency interface
 *  4. Create a project and empty workspace
 *  5. Select a real filesystem directory via the picker
 *  6. Launch terminal-only workspace
 *  7. Run pwd and verify exact directory
 *  8. Launch two shells in different directories
 *  9. Verify independent sessions and terminal identities
 * 10. Verify resize using stty size
 * 11. Verify ANSI and interactive input
 * 12. Verify Ctrl+C interrupts a running shell command
 * 13. Verify browser disconnect/reconnect attaches to the SAME PTY and does not spawn another process
 * 14. Verify output replay is present
 * 15. Mark Done while a disposable process is running; verify it stays alive
 * 16. Restore workspace and reattach to the same process
 * 17. Explicit Stop ends only the intended process
 * 18. Verify actual exit status and persisted lifecycle
 * 19. Restart backend and verify metadata recovery, without pretending the original OS process survived
 * 20. Verify unsupported native model/effort controls remain disabled
 * 21. Verify offline mutations are not replayed
 * 22. Verify profile configuration preserves exact executable and literal argv
 * 23. Verify protected directories cannot be selected
 * 24. Verify launch/delete races are prevented
 * 25. Verify profile storage failure does not terminate the server
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, realpath, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { ansiGreen, executed, interrupted, exited, rejectedUpgrade } from './terminal-evidence.mjs';
import { chromium } from 'playwright';

// Polyfill window for imports from web package
if (typeof globalThis.window === 'undefined') {
  globalThis.window = {
    location: { search: '', pathname: '/' },
    history: { replaceState: () => {} },
  };
}

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(serverDir, '../..');

let failures = 0;
const check = (num, label, ok, extra = '') => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} [${String(num).padStart(2, '0')}] ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
};

const root = await mkdtemp(path.join(tmpdir(), 'aw-agency-e2e-'));
const testHome = path.join(root, 'home');
const testAppdata = path.join(root, 'appdata');
const testXdg = path.join(root, 'xdg');
const workspacesDir = path.join(root, 'workspaces');
await mkdir(testHome, { recursive: true });
await mkdir(testAppdata, { recursive: true });
await mkdir(testXdg, { recursive: true });
await mkdir(workspacesDir, { recursive: true });

// Prevent zsh newuser install wizard on clean home
await writeFile(path.join(testHome, '.zshrc'), '# e2e test\n');
await writeFile(path.join(testHome, '.zshenv'), '# e2e test\n');
await writeFile(path.join(testHome, '.bashrc'), '# e2e test\n');

const wsDirAlpha = path.join(workspacesDir, 'ws-alpha');
const wsDirBeta = path.join(workspacesDir, 'ws-beta');
await mkdir(wsDirAlpha, { recursive: true });
await mkdir(wsDirBeta, { recursive: true });
const canonicalAlpha = await realpath(wsDirAlpha);
const canonicalBeta = await realpath(wsDirBeta);

// Protected CLI directory
const protectedCliDir = path.join(testHome, '.claude');
await mkdir(protectedCliDir, { recursive: true });

const commonEnv = {
  ...process.env,
  AGENT_WORKBENCH_NO_OPEN: '1',
  AGENT_WORKBENCH_NO_RESTORE: '1',
  HOME: testHome,
  USERPROFILE: testHome,
  APPDATA: testAppdata,
  XDG_CONFIG_HOME: testXdg,
  XDG_DATA_HOME: path.join(testHome, '.local', 'share'),
  XDG_CACHE_HOME: path.join(testHome, '.cache'),
  XDG_STATE_HOME: path.join(testHome, '.local', 'state'),
  CODEX_HOME: path.join(testHome, '.codex'),
  PI_CODING_AGENT_DIR: path.join(testHome, '.pi', 'agent'),
  PI_CODING_AGENT_SESSION_DIR: path.join(testHome, '.pi', 'sessions'),
};

function startServer() {
  const child = spawn(
    'pnpm',
    ['--dir', 'packages/server', 'exec', 'tsx', 'src/index.ts', '--prod'],
    {
      cwd: repoRoot,
      env: commonEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  let log = '';
  const ready = new Promise((resolve) => {
    const onData = (chunk) => {
      log += chunk.toString();
      const match = log.match(/http:\/\/127\.0\.0\.1:(\d+)\/\?token=([\w-]+)/);
      if (match) {
        resolve({ port: Number(match[1]), token: match[2], url: match[0] });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => resolve({ error: `Server exited early with code ${code}\nLog: ${log}` }));
    setTimeout(() => resolve({ error: `Timeout waiting for server startup\nLog: ${log}` }), 45_000);
  });

  return { child, ready };
}

console.log('--- Agency End-to-End Acceptance Test ---');

let { child: serverProc, ready: serverReady } = startServer();
const s1 = await serverReady;
if (s1.error) {
  console.error(s1.error);
  process.exit(1);
}

// 1. Server starts on localhost with existing authentication
check(1, 'Server starts on localhost with existing authentication', s1.url.startsWith('http://127.0.0.1:'), s1.url);

const baseOrigin = `http://127.0.0.1:${s1.port}`;

// 2. Unknown token and foreign Origin are rejected
const resNoToken = await fetch(`${baseOrigin}/`);
const resBadToken = await fetch(`${baseOrigin}/?token=invalid-token`);
const resForeignOrigin = await fetch(s1.url, { headers: { Origin: 'http://malicious.attacker.com' } });

const wsRejectedToken = await rejectedUpgrade(WebSocket,
  `ws://127.0.0.1:${s1.port}/ws?token=wrong-token`, { Origin: baseOrigin });
const wsRejectedOrigin = await rejectedUpgrade(WebSocket,
  `ws://127.0.0.1:${s1.port}/ws?token=${s1.token}`, { Origin: 'http://evil.example.com' });
const wsRejectedHost = await rejectedUpgrade(WebSocket,
  `ws://127.0.0.1:${s1.port}/ws?token=${s1.token}`, { Origin: baseOrigin, Host: 'evil.example.com' });

check(
  2,
  'Unknown token and foreign Origin are rejected',
  resNoToken.status === 401 && resBadToken.status === 401 && resForeignOrigin.status === 403 && wsRejectedToken && wsRejectedOrigin && wsRejectedHost,
  `NoToken:${resNoToken.status} BadToken:${resBadToken.status} ForeignOrigin:${resForeignOrigin.status} WsToken:${wsRejectedToken} WsOrigin:${wsRejectedOrigin}`,
);

// 3. Browser loads the integrated Agency interface
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
const resPage = await page.goto(s1.url);
await page.locator('.agency-app').waitFor({ state: 'visible' });
await page.locator('.agency-sidebar-nav').waitFor({ state: 'visible' });
for (const width of [390, 768, 1024, 1440]) {
  await page.setViewportSize({ width, height: 900 });
  const dimensions = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }));
  assert.ok(dimensions.scrollWidth <= dimensions.width, `Page overflows at ${width}px: ${JSON.stringify(dimensions)}`);
  console.log(`Browser empty-state viewport ${width}px: document ${dimensions.scrollWidth}/${dimensions.width}px`);
}
check(
  3,
  'Browser loads the integrated Agency interface',
  resPage.status() === 200 && await page.locator('.agency-app').isVisible(),
  `HTTP ${resPage.status()}, React Agency interface visible`,
);
await browser.close();

// Helper for WebSocket Client
class AgencyClient {
  constructor(port, token) {
    this.port = port;
    this.token = token;
    this.ws = null;
    this.messages = [];
    this.handlers = [];
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://127.0.0.1:${this.port}/ws?token=${this.token}`, {
        headers: { Origin: `http://127.0.0.1:${this.port}` },
      });
      this.ws.on('open', () => resolve());
      this.ws.on('error', (err) => reject(err));
      this.ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === 'agency.error') {
            console.log('RECEIVED AGENCY ERROR:', msg);
          }
          this.messages.push(msg);
          for (let i = this.handlers.length - 1; i >= 0; i--) {
            const h = this.handlers[i];
            if (h.filter(msg)) {
              this.handlers.splice(i, 1);
              const mIdx = this.messages.indexOf(msg);
              if (mIdx !== -1) this.messages.splice(mIdx, 1);
              h.resolve(msg);
            }
          }
        } catch {}
      });
    });
  }

  send(msg) {
    this.ws.send(JSON.stringify(msg));
  }

  async waitForOutput(terminalId, targetText, timeoutMs = 10_000) {
    let accumulated = '';
    for (const m of this.messages) {
      if (m.type === 'terminal.output' && m.terminalId === terminalId) {
        accumulated += m.data;
        if (accumulated.includes(targetText)) return { matched: true, accumulated };
      }
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve({ matched: false, accumulated });
      }, timeoutMs);

      const filter = (m) => {
        if (m.type === 'terminal.output' && m.terminalId === terminalId) {
          accumulated += m.data;
          if (accumulated.includes(targetText)) {
            clearTimeout(timer);
            return true;
          }
        }
        return false;
      };
      this.handlers.push({ filter, resolve: () => resolve({ matched: true, accumulated }) });
    });
  }

  waitFor(filter, timeoutMs = 15_000) {
    const idx = this.messages.findIndex(filter);
    if (idx !== -1) {
      const existing = this.messages[idx];
      this.messages.splice(idx, 1);
      return Promise.resolve(existing);
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.handlers.findIndex((h) => h.resolve === resolve);
        if (idx !== -1) this.handlers.splice(idx, 1);
        reject(new Error(`Timeout waiting for message matching ${filter}`));
      }, timeoutMs);

      this.handlers.push({
        filter,
        resolve: (msg) => {
          clearTimeout(timer);
          const mIdx = this.messages.indexOf(msg);
          if (mIdx !== -1) this.messages.splice(mIdx, 1);
          resolve(msg);
        },
      });
    });
  }

  close() {
    this.ws?.close();
  }
}

const client1 = new AgencyClient(s1.port, s1.token);
await client1.connect();

// Wait for initial snapshots
const initProjSnapshot = await client1.waitFor((m) => m.type === 'agency.projects.snapshot');
const initWsSnapshot = await client1.waitFor((m) => m.type === 'agency.workspaces.snapshot');
const initProfSnapshot = await client1.waitFor((m) => m.type === 'agency.profiles.snapshot');
const initSessSnapshot = await client1.waitFor((m) => m.type === 'agency.sessions.snapshot');

// 4. Create a project and empty workspace
client1.send({
  type: 'agency.project.create',
  requestId: 'req-proj-4',
  name: 'Acceptance Project',
});

const projCreated = await client1.waitFor((m) => m.type === 'agency.project.created' && m.requestId === 'req-proj-4');
const projectId = projCreated.project.id;

check(4, 'Create a project', !!projectId && projCreated.project.name === 'Acceptance Project', `ProjectId: ${projectId}`);

// 5. Select a real filesystem directory via the picker
client1.send({ type: 'picker.open' });
const picker1 = await client1.waitFor((m) => m.type === 'picker.listing');
const pickerId = picker1.listing.pickerId;

// Navigate or create folder via picker
client1.send({ type: 'picker.create', pickerId, name: 'e2e-ws-alpha' });
const pickerCreated = await client1.waitFor((m) => m.type === 'picker.listing' && m.listing.pickerId === pickerId);
const chosenCwd = pickerCreated.listing.path;

client1.send({
  type: 'agency.workspace.create',
  requestId: 'req-ws-create-5',
  projectId,
  name: 'Alpha Workspace',
  pickerId,
});

const wsCreated = await client1.waitFor((m) => m.type === 'agency.workspace.created' && m.requestId === 'req-ws-create-5');
const workspace1 = wsCreated.workspace;

check(
  5,
  'Select a real filesystem directory via the picker',
  wsCreated.workspace.status === 'active' && wsCreated.workspace.cwd === chosenCwd,
  `Cwd: ${wsCreated.workspace.cwd}`,
);

// 6. Launch terminal-only workspace
client1.send({
  type: 'agency.session.create',
  requestId: 'req-sess-launch-6',
  workspaceId: workspace1.id,
  kind: 'terminal',
  cols: 80,
  rows: 24,
});

const sessCreated1 = await client1.waitFor((m) => m.type === 'agency.session.created' && m.requestId === 'req-sess-launch-6');
const session1 = sessCreated1.session;

check(
  6,
  'Launch terminal-only workspace',
  session1.kind === 'terminal' && session1.lifecycle === 'running' && !!session1.terminalId,
  `SessionId: ${session1.id}, TerminalId: ${session1.terminalId}`,
);

// 7. Run pwd and verify exact directory
// Attach to terminal to receive output
client1.send({
  type: 'terminal.attach',
  terminalId: session1.terminalId,
  cols: 80,
  rows: 24,
});

const replay1 = await client1.waitFor((m) => m.type === 'terminal.replay' && m.terminalId === session1.terminalId);
// Allow shell PTY to finish startup
await new Promise((r) => setTimeout(r, 500));

// Send pwd
client1.send({
  type: 'input',
  terminalId: session1.terminalId,
  data: 'pwd\n',
});

const out1 = await client1.waitForOutput(session1.terminalId, chosenCwd);
check(7, 'Run pwd and verify exact directory', out1.matched, `Output: ${JSON.stringify(out1.accumulated.trim())}`);

// 8. Launch two shells in different directories
// Create second workspace
client1.send({ type: 'picker.open' });
const picker2 = await client1.waitFor((m) => m.type === 'picker.listing' && m.listing.pickerId !== pickerId);
const picker2Id = picker2.listing.pickerId;
client1.send({ type: 'picker.create', pickerId: picker2Id, name: 'e2e-ws-beta' });
const pickerCreated2 = await client1.waitFor((m) => m.type === 'picker.listing' && m.listing.pickerId === picker2Id);
const chosenCwd2 = pickerCreated2.listing.path;

client1.send({
  type: 'agency.workspace.create',
  requestId: 'req-ws-create-8',
  projectId,
  name: 'Beta Workspace',
  pickerId: picker2Id,
});

const wsCreated2 = await client1.waitFor((m) => m.type === 'agency.workspace.created' && m.requestId === 'req-ws-create-8');
const workspace2 = wsCreated2.workspace;

client1.send({
  type: 'agency.session.create',
  requestId: 'req-sess-launch-8',
  workspaceId: workspace2.id,
  kind: 'terminal',
  cols: 80,
  rows: 24,
});

const sessCreated2 = await client1.waitFor((m) => m.type === 'agency.session.created' && m.requestId === 'req-sess-launch-8');
const session2 = sessCreated2.session;

client1.send({
  type: 'terminal.attach',
  terminalId: session2.terminalId,
  cols: 80,
  rows: 24,
});

await new Promise((r) => setTimeout(r, 500));

client1.send({
  type: 'input',
  terminalId: session2.terminalId,
  data: 'pwd\n',
});

const out2 = await client1.waitForOutput(session2.terminalId, chosenCwd2);
check(8, 'Launch two shells in different directories', out2.matched && chosenCwd !== chosenCwd2, `Dir1: ${chosenCwd}, Dir2: ${chosenCwd2}`);

// 9. Verify independent sessions and terminal identities
check(
  9,
  'Verify independent sessions and terminal identities',
  session1.id !== session2.id && session1.terminalId !== session2.terminalId && session1.workspaceId !== session2.workspaceId,
  `S1: ${session1.id} vs S2: ${session2.id}`,
);

// 10. Verify resize using stty size
client1.send({
  type: 'resize',
  terminalId: session1.terminalId,
  cols: 105,
  rows: 35,
});

client1.send({
  type: 'input',
  terminalId: session1.terminalId,
  data: 'stty size\n',
});

let sttyOutput = '';
const sttyMatched = await new Promise((resolve) => {
  const handler = (m) => {
    if (m.type === 'terminal.output' && m.terminalId === session1.terminalId) {
      sttyOutput += m.data;
      if (sttyOutput.includes('35 105')) {
        resolve(true);
      }
    }
  };
  client1.handlers.push({ filter: (m) => (handler(m), false), resolve: () => {} });
  setTimeout(() => resolve(false), 10_000);
});

check(10, 'Verify resize using stty size', sttyMatched, `Output: ${sttyOutput.trim()}`);

// 11. Verify ANSI and interactive input
const markerText = 'AGENCY_E2E_GREEN';
client1.send({
  type: 'input',
  terminalId: session1.terminalId,
  data: "printf '\\033[32m%s%s\\033[0m\\n' 'AGENCY_E2E_' 'GREEN'\n",
});

let ansiOutput = '';
const ansiMatched = await new Promise((resolve) => {
  const handler = (m) => {
    if (m.type === 'terminal.output' && m.terminalId === session1.terminalId) {
      ansiOutput += m.data;
      if (ansiGreen(ansiOutput, markerText)) {
        resolve(true);
      }
    }
  };
  client1.handlers.push({ filter: (m) => (handler(m), false), resolve: () => {} });
  setTimeout(() => resolve(false), 10_000);
});

check(11, 'Verify ANSI and interactive input', ansiMatched, 'Received ANSI colored output');

// 12. Verify Ctrl+C interrupts a running shell command
client1.send({
  type: 'input',
  terminalId: session1.terminalId,
  data: "printf '%s%s\\n' 'SLEEP_' 'STARTED'; sleep 60\n",
});

await client1.waitFor((m) => m.type === 'terminal.output' &&
  m.terminalId === session1.terminalId && m.data.includes('SLEEP_STARTED'));

await new Promise((r) => setTimeout(r, 200));

// Send Ctrl+C
client1.send({
  type: 'input',
  terminalId: session1.terminalId,
  data: '\x03',
});

// Follow up with probe
client1.send({
  type: 'input',
  terminalId: session1.terminalId,
  data: "printf '%s%s:%s\\n' 'INTERRUPT_' 'STATUS' \"$?\"\n",
});

let interruptOutput = '';
const interruptMatched = await new Promise((resolve) => {
  const handler = (m) => {
    if (m.type === 'terminal.output' && m.terminalId === session1.terminalId) {
      interruptOutput += m.data;
      if (interrupted(interruptOutput)) {
        resolve(true);
      }
    }
  };
  client1.handlers.push({ filter: (m) => (handler(m), false), resolve: () => {} });
  setTimeout(() => resolve(false), 10_000);
});

check(12, 'Verify Ctrl+C interrupts a running shell command', interruptMatched, 'Ctrl+C returned control to shell');

// 13. Verify browser disconnect/reconnect attaches to the SAME PTY and does not spawn another process
// Print PID to check against
client1.send({
  type: 'input',
  terminalId: session1.terminalId,
  data: 'echo PTY_PID_IS=$$; echo PTY_PID_END\n',
});

let pidOutput = '';
const origPid = await new Promise((resolve) => {
  const handler = (m) => {
    if (m.type === 'terminal.output' && m.terminalId === session1.terminalId) {
      pidOutput += m.data;
      const match = pidOutput.match(/PTY_PID_IS=(\d+)/);
      if (match) resolve(match[1]);
    }
  };
  client1.handlers.push({ filter: (m) => (handler(m), false), resolve: () => {} });
  setTimeout(() => resolve(null), 10_000);
});

// Disconnect client 1
client1.close();

// Connect client 2
const client2 = new AgencyClient(s1.port, s1.token);
await client2.connect();

const reconnectSnapshots = await client2.waitFor((m) => m.type === 'agency.sessions.snapshot');
const reattachedSession = reconnectSnapshots.sessions.find((s) => s.id === session1.id);

client2.send({
  type: 'terminal.attach',
  terminalId: session1.terminalId,
  cols: 80,
  rows: 24,
});

client2.send({
  type: 'input',
  terminalId: session1.terminalId,
  data: 'echo PTY_PID2_IS=$$; echo PTY_PID2_END\n',
});

let pid2Output = '';
const reattachedPid = await new Promise((resolve) => {
  const handler = (m) => {
    if (m.type === 'terminal.output' && m.terminalId === session1.terminalId) {
      pid2Output += m.data;
      const match = pid2Output.match(/PTY_PID2_IS=(\d+)/);
      if (match) resolve(match[1]);
    }
  };
  client2.handlers.push({ filter: (m) => (handler(m), false), resolve: () => {} });
  setTimeout(() => resolve(null), 10_000);
});

check(
  13,
  'Verify browser disconnect/reconnect attaches to the SAME PTY and does not spawn another process',
  reattachedSession?.lifecycle === 'running' && origPid !== null && origPid === reattachedPid,
  `OrigPID: ${origPid}, ReattachedPID: ${reattachedPid}`,
);

// 14. Verify bounded output replay
// Replay received in client2 on attach
const replay2 = await client2.waitFor((m) => m.type === 'terminal.replay' && m.terminalId === session1.terminalId);
check(
  14,
  'Verify output replay is present',
  replay2 && typeof replay2.data === 'string' && replay2.data.length > 0 && typeof replay2.truncated === 'boolean',
  `Replay bytes: ${replay2.data.length}, truncated: ${replay2.truncated}`,
);

// 15. Mark Done while a disposable process is running; verify it stays alive
client2.send({
  type: 'input',
  terminalId: session1.terminalId,
  data: 'sleep 100 & BG_SLEEP_PID=$!; echo BG_SLEEP_STARTED=$BG_SLEEP_PID\n',
});

let bgPid = null;
await new Promise((resolve) => {
  let out = '';
  const handler = (m) => {
    if (m.type === 'terminal.output' && m.terminalId === session1.terminalId) {
      out += m.data;
      const match = out.match(/BG_SLEEP_STARTED=(\d+)/);
      if (match) {
        bgPid = match[1];
        resolve();
      }
    }
  };
  client2.handlers.push({ filter: (m) => (handler(m), false), resolve: () => {} });
  setTimeout(resolve, 8000);
});

client2.send({
  type: 'agency.workspace.done',
  requestId: 'req-done-15',
  workspaceId: workspace1.id,
});

const wsDoneRes = await client2.waitFor((m) => m.type === 'agency.workspace.done' && m.requestId === 'req-done-15');

// Check that session is still reported as alive / running
client2.send({ type: 'agency.sessions.list', requestId: 'req-check-alive', workspaceId: workspace1.id });
const listDone = await client2.waitFor((m) => m.type === 'agency.sessions.snapshot' && m.requestId === 'req-check-alive');
const sessDone = listDone.sessions.find((s) => s.id === session1.id);

check(
  15,
  'Mark Done while a disposable process is running; verify it stays alive',
  wsDoneRes.workspace.status === 'done' && sessDone?.lifecycle === 'running',
  `WsStatus: ${wsDoneRes.workspace.status}, SessLifecycle: ${sessDone?.lifecycle}`,
);

// 16. Restore workspace and reattach to the same process
client2.send({
  type: 'agency.workspace.restore',
  requestId: 'req-rest-16',
  workspaceId: workspace1.id,
});

const wsRestRes = await client2.waitFor((m) => m.type === 'agency.workspace.restored' && m.requestId === 'req-rest-16');

// Interact with the session again
client2.send({
  type: 'input',
  terminalId: session1.terminalId,
  data: "printf '%s%s\\n' 'RESTORE_PROBE_' 'ALIVE'\n",
});

let probeOutput = '';
const probeMatched = await new Promise((resolve) => {
  const handler = (m) => {
    if (m.type === 'terminal.output' && m.terminalId === session1.terminalId) {
      probeOutput += m.data;
      if (executed(probeOutput, 'RESTORE_PROBE_ALIVE')) {
        resolve(true);
      }
    }
  };
  client2.handlers.push({ filter: (m) => (handler(m), false), resolve: () => {} });
  setTimeout(() => resolve(false), 10_000);
});

check(16, 'Restore workspace and reattach to the same process', wsRestRes.workspace.status === 'active' && probeMatched, 'Reattached and interacted after restore');

// 17. Explicit Stop ends only the intended process
client2.send({
  type: 'terminal.close',
  terminalId: session1.terminalId,
});

// Await session activity or changed marking session 1 as exited
const sessStopped1 = await client2.waitFor(
  (m) =>
    (m.type === 'agency.session.activity' && m.sessionId === session1.id && m.lifecycle === 'exited') ||
    (m.type === 'agency.session.changed' && m.sessionId === session1.id && m.session.lifecycle === 'exited'),
);

// Check session 2 is still running
client2.send({ type: 'agency.sessions.list', requestId: 'req-check-s2', workspaceId: workspace2.id });
const listS2 = await client2.waitFor((m) => m.type === 'agency.sessions.snapshot' && m.requestId === 'req-check-s2');
const s2Active = listS2.sessions.find((s) => s.id === session2.id)?.lifecycle === 'running';

check(
  17,
  'Explicit Stop ends only the intended process',
  !!sessStopped1 && s2Active,
  `S1 stopped: ${!!sessStopped1}, S2 still running: ${s2Active}`,
);

// 18. Verify actual exit status and persisted lifecycle
client2.send({ type: 'agency.sessions.list', requestId: 'req-check-lifecycle-18', workspaceId: workspace1.id });
const listLifecycle = await client2.waitFor((m) => m.type === 'agency.sessions.snapshot' && m.requestId === 'req-check-lifecycle-18');
const s1Final = listLifecycle.sessions.find((s) => s.id === session1.id);

check(
  18,
  'Verify actual exit status and persisted lifecycle',
  exited(s1Final),
  `Lifecycle: ${s1Final?.lifecycle}, Code: ${s1Final?.exitCode}`,
);

// 19. Restart backend and verify metadata recovery, without pretending the original OS process survived
// Close client 2
client2.close();

// Kill server 1
serverProc.kill();
await new Promise((r) => serverProc.once('exit', r));

// Start server 2 with exact same testHome, testAppdata, testXdg
let { child: serverProc2, ready: serverReady2 } = startServer();
const s2 = await serverReady2;
if (s2.error) {
  console.error(s2.error);
  process.exit(1);
}

const client3 = new AgencyClient(s2.port, s2.token);
await client3.connect();

const postRestartWorkspaces = await client3.waitFor((m) => m.type === 'agency.workspaces.snapshot');
const postRestartSessions = await client3.waitFor((m) => m.type === 'agency.sessions.snapshot');

const recoveredWs1 = postRestartWorkspaces.workspaces.find((w) => w.id === workspace1.id);
const recoveredWs2 = postRestartWorkspaces.workspaces.find((w) => w.id === workspace2.id);
const recoveredS1 = postRestartSessions.sessions.find((s) => s.id === session1.id);
const recoveredS2 = postRestartSessions.sessions.find((s) => s.id === session2.id);

check(
  19,
  'Restart backend and verify metadata recovery, without pretending the original OS process survived',
  !!recoveredWs1 && !!recoveredWs2 && recoveredS1?.lifecycle === 'exited' && recoveredS2?.lifecycle === 'exited',
  `Ws1: ${!!recoveredWs1}, Ws2: ${!!recoveredWs2}, S1: ${recoveredS1?.lifecycle}, S2: ${recoveredS2?.lifecycle}`,
);

// 20. Verify unsupported native model/effort controls remain disabled
client3.send({
  type: 'agency.profile.capabilities.get',
  requestId: 'req-cap-20',
  profileId: 'claude-code',
});

const capMsg = await client3.waitFor((m) => m.type === 'agency.profile.capabilities' && m.requestId === 'req-cap-20');
check(
  20,
  'Verify unsupported native model/effort controls remain disabled',
  capMsg.capabilities.canSelectModel === false && capMsg.capabilities.canSelectEffort === false && capMsg.capabilities.models.length === 0,
  `Model: ${capMsg.capabilities.canSelectModel}, Effort: ${capMsg.capabilities.canSelectEffort}, Models: ${capMsg.capabilities.models.length}`,
);

// 21. Verify offline mutations are not replayed
// Test AgentConnection sendImmediate behavior directly
const { AgentConnection } = await import('../../web/src/connection.ts');
const mockListener = {
  onStatus: () => {},
  onMessage: () => {},
  onError: () => {},
  onClose: () => {},
};
const conn = new AgentConnection(mockListener);
const oldWebSocket = globalThis.WebSocket;
const sentAfterConnect = [];
globalThis.WebSocket = class {
  static OPEN = 1;
  readyState = 1;
  send(message) { sentAfterConnect.push(JSON.parse(message)); }
  close() {}
};
window.location.href = s1.url;
window.location.protocol = 'http:';
window.setTimeout = setTimeout;
window.clearTimeout = clearTimeout;
conn.connect();
conn.socket.onopen();
conn.socket.onclose({ code: 1006 });
const sendResult = conn.sendImmediate({ type: 'agency.project.create', requestId: 'offline-req', name: 'Offline' });
conn.connect();
conn.socket.onopen();
conn.close();
globalThis.WebSocket = oldWebSocket;
check(
  21,
  'Verify offline mutations are not replayed',
  sendResult === false && !sentAfterConnect.some((msg) => msg.requestId === 'offline-req'),
  `sendImmediate returned: ${sendResult}, replayed messages: ${sentAfterConnect.length}`,
);

// 22. Verify profile configuration preserves exact executable and literal argv
client3.send({
  type: 'agency.profile.configure',
  requestId: 'req-prof-cfg-22',
  profileId: 'codex-0',
  executable: '/bin/echo',
  args: ['literal "argv" test', '$SHELL', "don't expand"],
  environmentOverrides: { COLORTERM: 'truecolor' },
});

const cfgMsg = await client3.waitFor((m) => m.type === 'agency.profile.configured' && m.requestId === 'req-prof-cfg-22');
const cfg = cfgMsg.profile;
check(
  22,
  'Verify profile configuration preserves exact executable and literal argv',
  cfg.executable === '/bin/echo' &&
    cfg.args.length === 3 &&
    cfg.args[0] === 'literal "argv" test' &&
    cfg.args[1] === '$SHELL' &&
    cfg.args[2] === "don't expand" &&
    cfg.environmentOverrides?.['COLORTERM'] === 'truecolor',
  `Executable: ${cfg.executable}, Args: ${JSON.stringify(cfg.args)}`,
);

// 23. Verify protected directories cannot be selected
client3.send({ type: 'picker.open' });
const pickerProtected = await client3.waitFor((m) => m.type === 'picker.listing');
const pickerProtId = pickerProtected.listing.pickerId;

// Replace a selected directory after navigation, then request actual workspace creation.
client3.send({ type: 'picker.create', pickerId: pickerProtId, name: 'protected-swap' });
const swapListing = await client3.waitFor((m) => m.type === 'picker.listing' && m.listing.pickerId === pickerProtId);
await rm(swapListing.listing.path, { recursive: true });
await symlink(protectedCliDir, swapListing.listing.path, 'dir');
client3.send({ type: 'agency.workspace.create', requestId: 'protected-selection', projectId, name: 'Forbidden', pickerId: pickerProtId });
const protectedResult = await client3.waitFor((m) => m.requestId === 'protected-selection');

check(
  23,
  'Verify protected directories cannot be selected',
  protectedResult.type === 'agency.error',
  `Server response: ${protectedResult.type}`,
);

// 24. Verify launch/delete races are prevented
// Create fresh workspace
client3.send({ type: 'picker.open' });
const pickerRace = await client3.waitFor((m) => m.type === 'picker.listing' && m.listing.pickerId !== pickerProtId);
const pickerRaceId = pickerRace.listing.pickerId;
client3.send({ type: 'picker.create', pickerId: pickerRaceId, name: 'e2e-ws-race' });
const pickerRaceCreated = await client3.waitFor((m) => m.type === 'picker.listing' && m.listing.pickerId === pickerRaceId);

client3.send({
  type: 'agency.workspace.create',
  requestId: 'req-ws-race-create',
  projectId,
  name: 'Race Workspace',
  pickerId: pickerRaceId,
});

const wsRaceCreated = await client3.waitFor((m) => m.type === 'agency.workspace.created' && m.requestId === 'req-ws-race-create');
const raceWsId = wsRaceCreated.workspace.id;

// Simultaneously fire session.create and workspace.delete
client3.send({
  type: 'agency.session.create',
  requestId: 'race-session-create',
  workspaceId: raceWsId,
  kind: 'terminal',
  cols: 80,
  rows: 24,
});

client3.send({
  type: 'agency.workspace.delete',
  requestId: 'race-workspace-delete',
  workspaceId: raceWsId,
});

const [raceRes1, raceRes2] = await Promise.all([
  client3.waitFor((m) => m.requestId === 'race-session-create'),
  client3.waitFor((m) => m.requestId === 'race-workspace-delete'),
]);

// One must succeed and one must fail (conflict/session-unavailable or not-found), preventing corruption
const oneFailed =
  (raceRes1.type === 'agency.session.created' && raceRes2.type === 'agency.error') ||
  (raceRes1.type === 'agency.error' && raceRes2.type === 'agency.workspace.deleted');

check(
  24,
  'Verify launch/delete races are prevented',
  oneFailed,
  `Launch: ${raceRes1.type}, Delete: ${raceRes2.type}`,
);

// A store that becomes unreadable after startup must not crash the socket server.
const profileFile = path.join(testXdg, 'agent-workbench', 'agency-profiles.json');
await writeFile(profileFile, '{invalid');
await writeFile(profileFile + '.bak', '{invalid');
client3.send({ type: 'agency.profiles.list', requestId: 'corrupt-profile-list' });
const corruptResponse = await client3.waitFor((m) => m.requestId === 'corrupt-profile-list');
client3.send({ type: 'agency.projects.list', requestId: 'still-alive' });
const aliveResponse = await client3.waitFor((m) => m.requestId === 'still-alive');
check(25, 'Profile read failure returns an error without terminating the server',
  corruptResponse.type === 'agency.error' && aliveResponse.type === 'agency.projects.snapshot');

// Cleanup
client3.close();
serverProc2.kill();
await new Promise((r) => serverProc2.once('exit', r));

await rm(root, { recursive: true, force: true }).catch(() => {});

console.log('-----------------------------------------');
console.log(failures === 0 ? 'All 25 Acceptance Tests Passed!' : `${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
