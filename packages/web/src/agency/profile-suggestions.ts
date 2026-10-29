import type { CliProvider } from '@agent-workbench/shared';
import { t } from '../i18n/index.js';

/** 
 * Returns the suggested command-line executable for a given profile.
 * This is a UX hint only — it becomes the placeholder text in the dialog.
 * The user must explicitly type and save the executable; it is never auto-configured.
 */
export function suggestedExecutable(profileId: string, provider: CliProvider): string {
  // Each named wrapper is its own auth identity — suggest only the matching one.
  if (provider === 'codex') return profileId; // codex00, codex01, codex03
  if (provider === 'antigravity') return profileId; // agy00 through agy05
  if (provider === 'claude-code') return 'claude';
  return '';
}

/**
 * Provider-specific setup instructions shown during first-time configuration.
 */
export function providerSetupNote(provider: CliProvider): string {
  void provider;
  return t('agency.profile.noShareNotice');
}

/**
 * Provider-specific setup description shown during first-time configuration.
 */
export function providerSetupDescription(provider: CliProvider): string {
  if (provider === 'codex') {
    return t('agency.profile.setupNoteCodex');
  }
  if (provider === 'antigravity') {
    return t('agency.profile.setupNoteAntigravity');
  }
  if (provider === 'claude-code') {
    return t('agency.profile.setupNoteClaudeCode');
  }
  return t('agency.profile.setupNoteGeneric');
}

