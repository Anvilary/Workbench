import {
  normalizeWebTabTitle,
  validateChatGptUrl,
  validateGithubUrl,
  validateOtherWebUrl,
  validatePerplexityUrl,
  type AgencyCliProfile,
  type WebTabProvider,
} from '@agent-workbench/shared';
import type { WorkspaceTab } from './workspace-model.js';
import { t } from '../../i18n/index.js';

export type BrowserTabTargetResult =
  | { ok: true; url: string; provider: WebTabProvider; title: string }
  | { ok: false };

export function resolveBrowserTabTarget(options: {
  url: string;
  title?: string;
  provider?: WebTabProvider;
}): BrowserTabTargetResult {
  const { url: rawUrl, title: customTitle, provider: customProvider } = options;

  let provider: WebTabProvider = customProvider ?? 'other';
  let normalizedUrl = rawUrl;

  const chat = validateChatGptUrl(rawUrl);
  const perp = validatePerplexityUrl(rawUrl);
  const git = validateGithubUrl(rawUrl);
  const other = validateOtherWebUrl(rawUrl);

  if (chat.valid) {
    provider = 'chatgpt';
    normalizedUrl = chat.normalizedUrl!;
  } else if (perp.valid) {
    provider = 'perplexity';
    normalizedUrl = perp.normalizedUrl!;
  } else if (git.valid) {
    provider = 'github';
    normalizedUrl = git.normalizedUrl!;
  } else if (other.valid) {
    provider = 'other';
    normalizedUrl = other.normalizedUrl!;
  } else {
    return { ok: false };
  }

  const title =
    (customTitle && normalizeWebTabTitle(customTitle)) ||
    (provider === 'github'
      ? 'GitHub'
      : provider === 'perplexity'
        ? 'Perplexity'
        : provider === 'chatgpt'
          ? 'ChatGPT'
          : 'Browser');

  return { ok: true, url: normalizedUrl, provider, title };
}

export function getWorkspaceTabDisplayName(
  tab: WorkspaceTab,
  profiles: readonly AgencyCliProfile[],
): string {
  if (tab.kind === 'web') return tab.web.title;
  if (tab.kind === 'editor') return tab.editor.title;
  const session = tab.session;
  return (
    session.tab?.name ??
    (session.kind === 'terminal'
      ? t('agency.tabs.terminalNamed', { number: session.tab?.terminalNumber ?? 1 })
      : profiles.find((p) => p.id === session.profileId)?.label ?? t('agency.ui.agentLabel'))
  );
}
