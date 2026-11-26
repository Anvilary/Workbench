#!/usr/bin/env node
/**
 * Repository privacy gate.
 *
 *   node .github/scripts/privacy-gate.mjs paths      tracked text files must not contain personal home paths
 *   node .github/scripts/privacy-gate.mjs gitleaks   scan the current tree with a pinned, checksum-verified gitleaks
 *   node .github/scripts/privacy-gate.mjs all        both
 *
 * The path check is pattern based: it flags /home/<name>/ and /Users/<name>/
 * unless <name> is a generic placeholder. It never lists real identifiers.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const GENERIC_HOME_NAMES = new Set(['user', 'runner', 'example', 'test', 'ubuntu', 'node']);

// A home path at the start of a token, not a `/home/` segment inside a URL or longer path.
const HOME_PATH = /(?<![A-Za-z0-9_.~%-])\/(home|Users)\/([A-Za-z0-9_][A-Za-z0-9._-]*)\//g;

/** Every non-generic home path occurrence in `text`, as { line, column, match }. */
export function findHomePaths(text, allowedNames = GENERIC_HOME_NAMES) {
  const findings = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index++) {
    for (const match of lines[index].matchAll(HOME_PATH)) {
      if (allowedNames.has(match[2])) continue;
      findings.push({ line: index + 1, column: match.index + 1, match: match[0] });
    }
  }
  return findings;
}

/** Same heuristic as git: a NUL byte in the first 8000 bytes means binary. */
export function isBinary(buffer) {
  return buffer.subarray(0, 8000).includes(0);
}

/** Repo-relative paths from an allowlist file; blank lines and # comments are ignored. */
export function parseAllowlist(text) {
  return new Set(text.split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#')));
}

/** Redact the name so a gate failure never republishes the identifier in CI logs. */
function redact(match) {
  return match.replace(/^(\/(?:home|Users)\/)(.)[^/]*\//, (_, prefix, first) => `${prefix}${first}***/`);
}

function checkPaths(root) {
  const allowlistFile = path.join(root, '.github', 'privacy-gate-allowlist.txt');
  const allowlist = existsSync(allowlistFile) ? parseAllowlist(readFileSync(allowlistFile, 'utf8')) : new Set();
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0').filter(Boolean);
  let failures = 0;
  const unusedAllowlist = new Set(allowlist);
  for (const file of files) {
    let buffer;
    try {
      buffer = readFileSync(path.join(root, file));
    } catch {
      continue; // Deleted in the working tree or a submodule entry.
    }
    if (isBinary(buffer)) continue;
    const findings = findHomePaths(buffer.toString('utf8'));
    if (findings.length === 0) continue;
    if (allowlist.has(file)) {
      unusedAllowlist.delete(file);
      continue;
    }
    for (const finding of findings) {
      console.error(`${file}:${finding.line}:${finding.column}: personal home path ${redact(finding.match)}`);
      failures++;
    }
  }
  for (const file of unusedAllowlist) {
    console.warn(`privacy-gate: allowlist entry no longer needed: ${file}`);
  }
  if (failures > 0) {
    console.error(`privacy-gate: ${failures} personal home path(s). Use ~, $HOME, /home/user or a temporary directory.`);
    return false;
  }
  console.log(`privacy-gate: no personal home paths in ${files.length} tracked files.`);
  return true;
}

// Pinned gitleaks release. The sha256 is from the release's official checksums file.
const GITLEAKS_VERSION = '8.30.1';
const GITLEAKS_LINUX_X64_SHA256 = '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb';

async function checkGitleaks(root) {
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    throw new Error('The pinned gitleaks binary is linux x64 only.');
  }
  const name = `gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz`;
  const url = `https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/${name}`;
  const work = mkdtempSync(path.join(tmpdir(), 'privacy-gate-'));
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`gitleaks download failed: HTTP ${response.status}`);
    const archive = Buffer.from(await response.arrayBuffer());
    const digest = createHash('sha256').update(archive).digest('hex');
    if (digest !== GITLEAKS_LINUX_X64_SHA256) {
      throw new Error(`gitleaks checksum mismatch: expected ${GITLEAKS_LINUX_X64_SHA256}, got ${digest}`);
    }
    const archivePath = path.join(work, name);
    writeFileSync(archivePath, archive);
    execFileSync('tar', ['-xzf', archivePath, '-C', work, 'gitleaks'], { stdio: 'inherit' });
    // Scan a committed source tree. A developer's ignored profiles, caches and build
    // output are outside the repository and may contain unrelated private material.
    const source = path.join(work, 'source');
    mkdirSync(source);
    const tree = execFileSync('git', ['archive', 'HEAD'], { cwd: root, maxBuffer: 128 * 1024 * 1024 });
    execFileSync('tar', ['-xf', '-', '-C', source], { input: tree });
    const config = path.join(source, '.gitleaks.toml');
    const args = ['dir', '.', '--redact', '--no-banner', '--exit-code', '1'];
    if (existsSync(config)) args.push('--config', config);
    try {
      execFileSync(path.join(work, 'gitleaks'), args, { cwd: source, stdio: 'inherit' });
    } catch {
      console.error('privacy-gate: gitleaks reported findings (values redacted above).');
      return false;
    }
    return true;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function main() {
  const mode = process.argv[2] ?? 'all';
  if (!['paths', 'gitleaks', 'all'].includes(mode)) {
    console.error('Usage: privacy-gate.mjs [paths|gitleaks|all]');
    process.exit(2);
  }
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  let ok = true;
  if (mode !== 'gitleaks') ok = checkPaths(root) && ok;
  if (mode !== 'paths') ok = (await checkGitleaks(root)) && ok;
  process.exit(ok ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
