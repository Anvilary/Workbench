/**
 * What a browser tab of a given provider may navigate to and what counts as a
 * durable page worth remembering. Pure functions over the URL policy.
 */

import { embeddedUrl, githubEmbeddedUrl, otherUrl, perplexityEmbeddedUrl, perplexityUrl } from '../../policy.mjs';
import { isDurableProviderPage } from '../security/session-permissions.mjs';

export function navigationAllowed(provider, url) {
  if (provider === 'other') return otherUrl(url);
  if (provider === 'github') return githubEmbeddedUrl(url);
  if (provider === 'perplexity') return perplexityEmbeddedUrl(url);
  return embeddedUrl(url);
}

export function durablePage(provider, value) {
  return isDurableProviderPage(provider, value, { otherUrl, perplexityUrl });
}
