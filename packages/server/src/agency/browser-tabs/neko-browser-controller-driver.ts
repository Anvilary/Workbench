import { validateChatGptUrl } from '@agent-workbench/shared';
import {
  BrowserEngineUnavailableError,
  type BrowserControllerDriver,
  type OpenTargetResult,
  type TargetMetadata,
} from './browser-controller-driver.js';

export interface NekoBrowserControllerDriverOptions {
  baseUrl?: string;
  token?: string;
  timeoutMs?: number;
}

/** Only the authenticated managed controller API can establish ownership. */
export class NekoBrowserControllerDriver implements BrowserControllerDriver {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly owners = new Map<string, TargetMetadata>();

  constructor(options: NekoBrowserControllerDriverOptions = {}) {
    const endpoint = new URL(options.baseUrl ?? process.env.NEKO_CONTROLLER_URL ?? 'http://127.0.0.1:9223');
    if (
      endpoint.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(endpoint.hostname) ||
      endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/'
    ) {
      throw new BrowserEngineUnavailableError('Neko controller must use a dedicated HTTP loopback endpoint');
    }
    this.baseUrl = endpoint.origin;
    this.token = options.token ?? process.env.CONTROLLER_AUTH_TOKEN ?? process.env.NEKO_CONTROLLER_TOKEN ?? '';
    if (this.token.trim().length < 32 || /[\r\n]/.test(this.token)) {
      throw new BrowserEngineUnavailableError('Neko controller requires a server-side token of at least 32 characters');
    }
    this.timeoutMs = options.timeoutMs ?? 15_000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new BrowserEngineUnavailableError('Neko controller timeout must be positive');
    }
  }

  private async request(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: 'error',
      });
      // Do not include arbitrary upstream bodies, URLs or credentials in errors.
      if (!response.ok) {
        await response.body?.cancel();
        throw new BrowserEngineUnavailableError(`Neko controller rejected ${method} operation (HTTP ${response.status})`);
      }
      const value: unknown = await response.json();
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new BrowserEngineUnavailableError('Neko controller returned an invalid response');
      }
      return value as Record<string, unknown>;
    } catch (error) {
      if (error instanceof BrowserEngineUnavailableError) throw error;
      throw new BrowserEngineUnavailableError('Neko controller is unavailable or the operation could not be confirmed');
    }
  }

  private targetPath(targetRef: string): string {
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(targetRef)) {
      throw new BrowserEngineUnavailableError('Invalid browser target reference');
    }
    return `/managed/tabs/${encodeURIComponent(targetRef)}`;
  }

  private metadata(expected: TargetMetadata): TargetMetadata {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!uuid.test(expected.tabId) || !uuid.test(expected.workspaceId)) {
      throw new BrowserEngineUnavailableError('Valid tab and workspace ownership metadata are required');
    }
    return { tabId: expected.tabId, workspaceId: expected.workspaceId };
  }

  private owner(targetRef: string): TargetMetadata {
    const owner = this.owners.get(targetRef);
    if (!owner) throw new BrowserEngineUnavailableError('Browser target ownership has not been verified');
    return owner;
  }

  private url(url: string): string {
    const validation = validateChatGptUrl(url);
    if (!validation.valid) throw new BrowserEngineUnavailableError('Browser navigation requires a valid ChatGPT HTTPS URL');
    return validation.normalizedUrl!;
  }

  async openTarget(url: string, metadata?: TargetMetadata): Promise<OpenTargetResult> {
    if (!metadata) throw new BrowserEngineUnavailableError('Browser target ownership metadata is required');
    const owner = this.metadata(metadata);
    const response = await this.request('POST', '/managed/tabs', { url: this.url(url), metadata: owner });
    if (typeof response.id !== 'string' || typeof response.created !== 'boolean') {
      throw new BrowserEngineUnavailableError('Neko controller did not confirm target creation');
    }
    this.targetPath(response.id);
    this.owners.set(response.id, owner);
    return { targetRef: response.id };
  }

  async verifyTargetOwnership(targetRef: string, expected: TargetMetadata): Promise<boolean> {
    const owner = this.metadata(expected);
    const query = new URLSearchParams({ tabId: owner.tabId, workspaceId: owner.workspaceId });
    const response = await this.request('GET', `${this.targetPath(targetRef)}?${query}`);
    if (response.id !== targetRef || typeof response.verified !== 'boolean') {
      throw new BrowserEngineUnavailableError('Neko controller did not confirm target ownership');
    }
    if (response.verified) this.owners.set(targetRef, owner);
    else this.owners.delete(targetRef);
    return response.verified;
  }

  async activateTarget(targetRef: string): Promise<void> {
    const response = await this.request('POST', `${this.targetPath(targetRef)}/activate`, { metadata: this.owner(targetRef) });
    if (response.id !== targetRef || response.activated !== true) {
      throw new BrowserEngineUnavailableError('Neko controller did not confirm target activation');
    }
  }

  async getTargetUrl(targetRef: string): Promise<string | null> {
    const owner = this.owner(targetRef);
    const query = new URLSearchParams({ tabId: owner.tabId, workspaceId: owner.workspaceId });
    const response = await this.request('GET', `${this.targetPath(targetRef)}?${query}`);
    if (response.id !== targetRef || response.verified !== true) {
      throw new BrowserEngineUnavailableError('Neko controller could not verify the observed target');
    }
    if (typeof response.url !== 'string') return null;
    const validation = validateChatGptUrl(response.url);
    return validation.valid ? validation.normalizedUrl! : null;
  }

  async findOwnedTarget(expected: TargetMetadata): Promise<string | null> {
    const owner = this.metadata(expected);
    const query = new URLSearchParams({ tabId: owner.tabId, workspaceId: owner.workspaceId });
    const response = await this.request('GET', `/managed/tabs?${query}`);
    if (response.found === false && response.id === null) return null;
    if (response.found !== true || typeof response.id !== 'string') {
      throw new BrowserEngineUnavailableError('Neko controller did not confirm the ownership receipt');
    }
    this.targetPath(response.id);
    this.owners.set(response.id, owner);
    return response.id;
  }

  async navigateTarget(targetRef: string, url: string): Promise<void> {
    const normalized = this.url(url);
    const response = await this.request('POST', `${this.targetPath(targetRef)}/navigate`, {
      url: normalized, metadata: this.owner(targetRef),
    });
    if (response.id !== targetRef || response.navigated !== true || response.url !== normalized) {
      throw new BrowserEngineUnavailableError('Neko controller did not confirm navigation');
    }
  }

  async closeTarget(targetRef: string): Promise<void> {
    const response = await this.request('DELETE', this.targetPath(targetRef), { metadata: this.owner(targetRef) });
    if (response.id !== targetRef || response.closed !== true) {
      throw new BrowserEngineUnavailableError('Neko controller did not confirm target destruction');
    }
    this.owners.delete(targetRef);
  }

  async isTargetAlive(targetRef: string): Promise<boolean> {
    this.targetPath(targetRef);
    const response = await this.request('GET', '/tabs');
    if (!Array.isArray(response.tabs)) throw new BrowserEngineUnavailableError('Neko target inventory is unavailable');
    return response.tabs.some((tab: unknown) => !!tab && typeof tab === 'object' && 'id' in tab && tab.id === targetRef);
  }
}
