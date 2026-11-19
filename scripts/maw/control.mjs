import { spawn } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readlinkSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readyService, systemdMainPid } from './service-readiness.mjs';

function unitPid(unit) {
  const pid = systemdMainPid(unit);
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`${unit} has no active MainPID`);
  return pid;
}

function supervisorUnit() {
  return process.env.MAW_PTYD_UNIT || 'maw-ptyd.service';
}

function supervisorConfig() {
  let socketPath = process.env.MAW_PTYD_SOCKET;
  let authPath = process.env.MAW_PTYD_AUTH_FILE;
  if (!socketPath || !authPath) {
    const environ = unitEnvironment(supervisorUnit());
    for (const value of environ) {
      if (value.startsWith('MAW_PTYD_SOCKET=')) socketPath ||= value.slice('MAW_PTYD_SOCKET='.length);
      if (value.startsWith('MAW_PTYD_AUTH_FILE=')) authPath ||= value.slice('MAW_PTYD_AUTH_FILE='.length);
    }
  }
  const runtime = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 0}`;
  return {
    socketPath: socketPath || path.join(runtime, process.env.MAW_PTYD_RUNTIME_NAME || 'maw-ptyd', 'ptyd.sock'),
    authPath: authPath || `${socketPath || path.join(runtime, 'maw-ptyd', 'ptyd.sock')}.auth`,
  };
}

function unitEnvironment(unit) {
  return readFileSync(`/proc/${unitPid(unit)}/environ`, 'utf8').split('\0');
}

function isPersistentBackend() {
  const env = unitEnvironment(process.env.MAW_UNIT || 'maw.service');
  return env.includes('MAW_PERSISTENT_PTY=1') && !env.includes('MAW_DISABLE_PTYD=1');
}

async function supervisorIsEmpty() {
  const { socketPath, authPath } = supervisorConfig();
  const dirStat = lstatSync(path.dirname(authPath));
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink() || dirStat.uid !== process.getuid?.() || (dirStat.mode & 0o077)) {
    throw new Error('PTY supervisor runtime directory permissions are unsafe');
  }
  const authStat = lstatSync(authPath);
  if (!authStat.isFile() || authStat.isSymbolicLink() || authStat.uid !== process.getuid?.() || (authStat.mode & 0o077)) {
    throw new Error('PTY supervisor auth file permissions are unsafe');
  }
  const token = readFileSync(authPath, 'utf8').trim();
  if (!/^[\da-f]{64}$/i.test(token)) throw new Error('PTY supervisor auth token is invalid');
  const reqId = randomUUID();
  const snapshot = await new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let pending = '';
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('PTY supervisor handshake timed out')); }, 3000);
    socket.once('error', (error) => { clearTimeout(timer); reject(error); });
    socket.on('data', (chunk) => {
      pending += chunk.toString('utf8');
      const newline = pending.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timer);
      try {
        const response = JSON.parse(pending.slice(0, newline));
        if (response.reqId !== reqId || response.op !== 'snapshot' || !Array.isArray(response.sessions) ||
            response.sessions.some(session => !session || typeof session.alive !== 'boolean')) {
          throw new Error(response.message || 'Invalid PTY supervisor snapshot');
        }
        resolve(response);
      } catch (error) { reject(error); }
      socket.destroy();
    });
    socket.once('connect', () => socket.write(`${JSON.stringify({ op: 'hello', reqId, version: 1, authToken: token, subscribe: false })}\n`));
  });
  return snapshot.sessions.filter((session) => session?.alive === true).length === 0;
}

function checkDataCompatibility(target) {
  const manifestPath = path.join(target, 'package.json');
  let supportedVersion = 1;
  let supportedAssignments = 0;
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const declared = manifest.mawCompatibility?.browserTabStore;
    if (declared !== undefined) {
      if (!Number.isSafeInteger(declared) || declared < 1) throw new Error('Target release has invalid browser tab compatibility metadata');
      supportedVersion = declared;
    }
    supportedAssignments = manifest.mawCompatibility?.browserProfileAssignments ?? 0;
    if (!Number.isSafeInteger(supportedAssignments) || supportedAssignments < 0) {
      throw new Error('Target release has invalid browser profile assignment compatibility metadata');
    }
  }
  const configRoot = process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || '', '.config');
  const storePath = path.join(configRoot, 'agent-workbench', 'agency-web-tabs.json');
  for (const candidate of [storePath, `${storePath}.bak`]) {
    if (!existsSync(candidate)) continue;
    const stat = lstatSync(candidate);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Browser tab store path is unsafe: ${candidate}`);
    let decoded;
    try { decoded = JSON.parse(readFileSync(candidate, 'utf8')); }
    catch { throw new Error(`Browser tab store cannot be safely inspected: ${candidate}`); }
    if (!Number.isSafeInteger(decoded.version) || decoded.version < 1) throw new Error(`Browser tab store version is invalid: ${candidate}`);
    if (decoded.version > supportedVersion) {
      throw new Error(`Target supports browser tab store v${supportedVersion}, but ${candidate} is v${decoded.version}`);
    }
  }
  if (supportedAssignments < 1) {
    const workspaceStorePath = path.join(configRoot, 'agent-workbench', 'agency-state.json');
    const readWorkspaceSnapshot = (candidate) => {
      let stat;
      try { stat = lstatSync(candidate); }
      catch (error) { if (error.code === 'ENOENT') return { missing: true }; throw error; }
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Workspace store path is unsafe: ${candidate}`);
      let snapshot;
      try { snapshot = JSON.parse(readFileSync(candidate, 'utf8')); }
      catch { return { corrupt: true, candidate }; }
      if (!Array.isArray(snapshot?.projects) || !Array.isArray(snapshot?.workspaces)) {
        return { corrupt: true, candidate };
      }
      return { snapshot };
    };
    const primary = readWorkspaceSnapshot(workspaceStorePath);
    let activeSnapshot = primary.snapshot;
    if (!activeSnapshot) {
      const backup = readWorkspaceSnapshot(`${workspaceStorePath}.bak`);
      if (backup.snapshot) {
        activeSnapshot = backup.snapshot;
      } else if (primary.corrupt || backup.corrupt) {
        throw new Error(`Workspace store cannot be safely inspected: ${primary.corrupt ? workspaceStorePath : `${workspaceStorePath}.bak`}`);
      }
    }
    if (activeSnapshot && [...activeSnapshot.projects, ...activeSnapshot.workspaces].some(row => row?.browserProfileId != null)) {
      throw new Error('Target does not preserve browser profile assignments. Clear the assignments in Workbench before rolling back.');
    }
  }
}

try {
  if (process.argv[2] === 'ptyd-empty') {
    if (!await supervisorIsEmpty()) throw new Error('live PTY sessions exist');
    console.log('PTY supervisor has no live sessions.');
    process.exit(0);
  }
  if (process.argv[2] === 'ptyd-release') {
    // systemd starts maw-ptyd with its release as WorkingDirectory. Its cwd
    // remains there when the current symlink later changes.
    const unit = supervisorUnit();
    const pid = unitPid(unit);
    const release = readlinkSync(`/proc/${pid}/cwd`);
    if (unitPid(unit) !== pid) throw new Error('PTY supervisor changed while identifying its release');
    console.log(release);
    process.exit(0);
  }
  if (process.argv[2] === 'check-data') {
    if (!process.argv[3]) throw new Error('Target release directory is required');
    checkDataCompatibility(process.argv[3]);
    process.exit(0);
  }
  if (process.argv[2] === 'backend-mode') {
    console.log(isPersistentBackend() ? 'persistent' : 'in-process');
    process.exit(0);
  }
  const { url, state, pid, noAuth } = await readyService();
  const release = typeof state.releaseId === 'string' ? `; release ${state.releaseId}` : '';
  const modeLabel = noAuth ? '; token-free local mode (MAW_UNSAFE_LOCAL_NO_AUTH=1)' : '';
  if (process.argv[2] === 'status') {
    console.log(`Healthy; PID ${pid}; loopback port ${url.port}${release}${modeLabel}`);
    console.log(`URL: ${url.origin}/`);
  }
  else if (process.argv[2] === 'url') console.log(noAuth ? url.origin + '/' : url.href);
  else if (process.argv[2] === 'open') {
    const browser = process.argv[3] || 'xdg-open';
    const child = spawn(browser, [url.href], { stdio: 'ignore' });
    child.on('error', () => { console.error('Could not open browser'); process.exitCode = 1; });
    child.on('exit', code => { process.exitCode = code === 0 ? 0 : 1; });
  } else throw new Error('Unknown control command');
} catch (err) {
  if (['check-data', 'ptyd-empty', 'ptyd-release', 'backend-mode'].includes(process.argv[2])) console.error(err instanceof Error ? err.message : String(err));
  else console.error('MAW is not ready. Use maw status and maw logs to inspect startup.');
  process.exitCode = 1;
}
