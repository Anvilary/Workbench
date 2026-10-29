import type { CliProvider } from '@agent-workbench/shared';

/** 
 * Returns the suggested command-line executable for a given profile.
 * This is a UX hint only — it becomes the placeholder text in the dialog.
 * The user must explicitly type and save the executable; it is never auto-configured.
 */
export function suggestedExecutable(profileId: string, provider: CliProvider): string {
  // Each named wrapper is its own auth identity — suggest only the matching one.
  if (provider === 'codex') return profileId; // codex-0, codex-1, codex-3
  if (provider === 'antigravity') return profileId; // agy-0 through agy-5
  if (provider === 'claude-code') return 'claude';
  return '';
}

/**
 * Provider-specific setup instructions shown during first-time configuration.
 */
export function providerSetupNote(provider: CliProvider): string {
  if (provider === 'codex') {
    return 'Each Codex profile uses its own named wrapper binary with separate credentials. ' +
      'Do not share executables between profiles.';
  }
  if (provider === 'antigravity') {
    return 'Each AGY profile uses its own named wrapper binary (agy-0–agy-5) with separate authentication. ' +
      'Do not share executables between profiles.';
  }
  if (provider === 'claude-code') {
    return 'Enter the path to the Claude Code CLI binary, typically "claude". ' +
      'Each Claude Code profile maintains its own authentication context.';
  }
  return 'Enter the full path or command name for this profile\'s CLI executable.';
}

/**
 * Provider-specific setup description shown during first-time configuration.
 */
export function providerSetupDescription(provider: CliProvider): string {
  if (provider === 'codex') {
    return 'Enter the path to your Codex wrapper. Each Codex profile uses its own named wrapper (e.g., codex-0) with separate credentials.';
  }
  if (provider === 'antigravity') {
    return 'Enter the path to your AGY wrapper. Each AGY profile uses its own named wrapper (e.g., agy-0) with separate credentials.';
  }
  if (provider === 'claude-code') {
    return 'Enter the path to the Claude Code CLI. Typically claude or an absolute path.';
  }
  return 'Enter the path to your CLI executable.';
}
