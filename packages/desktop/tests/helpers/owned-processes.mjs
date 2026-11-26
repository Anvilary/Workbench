// Ownership-based cleanup for fixtures that run real CLIs under a disposable HOME.
//
// Some CLIs (for example `codex`) start managed daemons that call setsid and
// reparent to the init/user manager, so killing the fixture's child or its
// process group does not reach them. The fixture's unique temporary HOME is the
// ownership marker: only processes whose environ has exactly `HOME=<home>` are
// signalled. Nothing is ever matched by executable name.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

function environHome(pid) {
  try {
    const raw = readFileSync(`/proc/${pid}/environ`);
    for (const entry of raw.toString('utf8').split('\0')) {
      if (entry.startsWith('HOME=')) return entry.slice(5);
    }
  } catch {
    // Exited, or not ours (environ of foreign processes is unreadable).
  }
  return null;
}

/** PIDs (other than this process) whose environment HOME equals `home` exactly. */
export function pidsWithHome(home) {
  if (process.platform !== 'linux') return [];
  const target = path.resolve(home);
  if (!path.isAbsolute(home) || target === '/' || target === path.resolve(process.env.HOME || '/')) {
    throw new Error(`Refusing to match processes by a non-fixture HOME: ${home}`);
  }
  const pids = [];
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (pid === process.pid) continue;
    if (environHome(pid) === target) pids.push(pid);
  }
  return pids;
}

function signalOwned(pid, home, signal) {
  // Re-check right before signalling so a recycled PID is never hit.
  if (environHome(pid) !== path.resolve(home)) return;
  try { process.kill(pid, signal); } catch {}
}

/** Synchronous SIGKILL of every process owned by `home`; usable from exit handlers. */
export function killProcessesWithHomeSync(home) {
  const pids = pidsWithHome(home);
  for (const pid of pids) signalOwned(pid, home, 'SIGKILL');
  return pids;
}

/**
 * Terminates every process owned by `home`: SIGTERM first, SIGKILL after
 * `graceMs`, rescanning until nothing remains (late daemon spawns included).
 * Resolves with the PIDs that were found; rejects if any survive `timeoutMs`.
 */
export async function reapProcessesWithHome(home, { graceMs = 2000, timeoutMs = 10000 } = {}) {
  const started = Date.now();
  const seen = new Set();
  const termed = new Set();
  let quietSince = null;
  while (true) {
    const pids = pidsWithHome(home);
    if (pids.length === 0) {
      quietSince ??= Date.now();
      // Stay a little longer to catch a daemon spawned during teardown.
      if (Date.now() - quietSince >= 200) return [...seen];
    } else {
      quietSince = null;
      for (const pid of pids) {
        seen.add(pid);
        const escalate = termed.has(pid) && Date.now() - started >= graceMs;
        signalOwned(pid, home, escalate ? 'SIGKILL' : 'SIGTERM');
        termed.add(pid);
      }
    }
    if (Date.now() - started > timeoutMs) {
      const left = pidsWithHome(home);
      if (left.length > 0) throw new Error(`Processes still running with HOME=${home}: ${left.join(', ')}`);
      return [...seen];
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * Kills processes owned by `home` if the test process exits or is interrupted
 * before its own teardown runs. Returns a disposer for the normal path.
 */
export function guardHomeProcessesOnExit(home) {
  const onExit = () => { try { killProcessesWithHomeSync(home); } catch {} };
  const onSignal = (signal) => {
    onExit();
    dispose();
    process.kill(process.pid, signal);
  };
  const dispose = () => {
    process.off('exit', onExit);
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  };
  process.on('exit', onExit);
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  return dispose;
}
