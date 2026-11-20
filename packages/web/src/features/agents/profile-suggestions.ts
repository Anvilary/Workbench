import type { CliProvider } from '@agent-workbench/shared';
import { t } from '../../i18n/index.js';

/** 
 * Returns the suggested command-line executable for a given profile.
 * This is a UX hint only: it becomes the placeholder text in the dialog.
 * The user must explicitly type and save the executable; it is never auto-configured.
 */
export function suggestedExecutable(profileId: string, provider: CliProvider): string {
  // Each named wrapper is its own auth identity: suggest only the matching one.
  if (provider === 'codex') return profileId; // codex-0, codex-1, codex-3
  if (provider === 'antigravity') return profileId; // agy-0 through agy-5
  if (provider === 'claude-code') return 'claude';
  if (provider === 'opencode') return 'opencode';
  if (provider === 'pi') return 'pi';
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
  if (provider === 'opencode') {
    return t('agency.profile.setupNoteOpenCode');
  }
  if (provider === 'pi') {
    return t('agency.profile.setupNotePi');
  }
  return t('agency.profile.setupNoteGeneric');
}

