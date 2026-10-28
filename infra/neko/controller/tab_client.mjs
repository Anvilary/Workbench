#!/usr/bin/env node
/**
 * Node.js / ES Module client for the Restricted CDP Tab Controller.
 * Provides programmatic tab switching, enumeration, and creation for MAW.
 */

export class TabClient {
  constructor(options = {}) {
    this.baseUrl = (options.baseUrl || process.env.NEKO_CONTROLLER_URL || 'http://127.0.0.1:9223').replace(/\/$/, '');
    this.token = options.token || process.env.CONTROLLER_AUTH_TOKEN || process.env.NEKO_CONTROLLER_TOKEN || '';
  }

  async #request(method, path, body = null) {
    const headers = {};
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }
    const init = { method, headers };
    if (body !== null) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const res = await fetch(`${this.baseUrl}${path}`, init);
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(`Controller request failed [${res.status}]: ${err.error || res.statusText}`);
    }
    return res.json();
  }

  async health() {
    return this.#request('GET', '/health');
  }

  async listTabs() {
    const res = await this.#request('GET', '/tabs');
    return res.tabs || [];
  }

  async createTab(url = 'https://chatgpt.com') {
    return this.#request('POST', '/tabs', { url });
  }

  async activateTab(tabId) {
    return this.#request('POST', `/tabs/${encodeURIComponent(tabId)}/activate`);
  }

  async navigateTab(tabId, url) {
    return this.#request('POST', `/tabs/${encodeURIComponent(tabId)}/navigate`, { url });
  }

  async closeTab(tabId) {
    return this.#request('DELETE', `/tabs/${encodeURIComponent(tabId)}`);
  }
}

// CLI invocation support
if (import.meta.url === `file://${process.argv[1]}`) {
  const [,, cmd, arg1, arg2] = process.argv;
  const client = new TabClient();
  try {
    if (cmd === 'health') {
      console.log(JSON.stringify(await client.health(), null, 2));
    } else if (cmd === 'list') {
      console.log(JSON.stringify(await client.listTabs(), null, 2));
    } else if (cmd === 'new') {
      console.log(JSON.stringify(await client.createTab(arg1), null, 2));
    } else if (cmd === 'activate') {
      console.log(JSON.stringify(await client.activateTab(arg1), null, 2));
    } else if (cmd === 'navigate') {
      console.log(JSON.stringify(await client.navigateTab(arg1, arg2), null, 2));
    } else if (cmd === 'close') {
      console.log(JSON.stringify(await client.closeTab(arg1), null, 2));
    } else {
      console.log('Usage: node tab_client.mjs <health|list|new [url]|activate <id>|navigate <id> <url>|close <id>>');
      process.exit(1);
    }
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}
