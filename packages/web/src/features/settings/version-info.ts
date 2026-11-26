import type { AgentId } from '@anvilary/workbench-shared';

export interface AppVersionInfo {
  version: string;
  gitSha: string | null;
  isDev: boolean;
  displayVersion: string;
}

export interface RuntimeInfo {
  appVersion: string;
  displayVersion: string;
  electronVersion: string;
  chromiumVersion: string;
  platform: string;
}

export function toggled(list: readonly AgentId[], agent: AgentId, off: boolean): AgentId[] {
  const rest = list.filter((id) => id !== agent);
  return off ? [...rest, agent] : rest;
}

export function sameSet(a: readonly AgentId[], b: readonly AgentId[]): boolean {
  return a.length === b.length && a.every((id) => b.includes(id));
}

export function getAppVersionInfo(): AppVersionInfo {
  let version = '0.8.1';
  if (typeof __APP_VERSION__ === 'string' && __APP_VERSION__ !== 'dev' && __APP_VERSION__ !== 'test') {
    version = __APP_VERSION__;
  } else if (typeof process !== 'undefined' && process.env?.WORKBENCH_APP_VERSION) {
    version = process.env.WORKBENCH_APP_VERSION;
  }

  let gitSha: string | null = null;
  if (typeof __APP_GIT_SHA__ === 'string' && __APP_GIT_SHA__.trim().length > 0) {
    gitSha = __APP_GIT_SHA__.trim().slice(0, 7);
  } else if (typeof process !== 'undefined') {
    const rawSha = process.env?.GIT_SHA || process.env?.VITE_GIT_SHA;
    if (rawSha && rawSha.trim().length > 0) {
      gitSha = rawSha.trim().slice(0, 7);
    }
  }

  const isDev = Boolean(
    gitSha ||
    (typeof __APP_IS_DEV__ === 'boolean' && __APP_IS_DEV__) ||
    (typeof import.meta !== 'undefined' && (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV) ||
    (typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production' && process.env?.NODE_ENV !== 'test'),
  );

  const displayVersion = isDev && gitSha
    ? `v${version} (dev @${gitSha})`
    : isDev
      ? `v${version} (dev)`
      : `v${version}`;

  return {
    version,
    gitSha,
    isDev,
    displayVersion,
  };
}

export function getRuntimeInfo(): RuntimeInfo {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  const electronMatch = ua.match(/Electron\/([\d.]+)/);
  const chromeMatch = ua.match(/Chrome\/([\d.]+)/);
  const versionInfo = getAppVersionInfo();

  return {
    appVersion: versionInfo.version,
    displayVersion: versionInfo.displayVersion,
    electronVersion: electronMatch?.[1] ?? '45.2.0',
    chromiumVersion: chromeMatch?.[1] ?? '134.0.6998.35',
    platform: typeof navigator !== 'undefined' && navigator.platform ? navigator.platform : 'Linux x86_64',
  };
}
