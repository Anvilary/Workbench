// Real Electron process. Fixture hosts only: this does not sign in to Google or LinkedIn.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { _electron as electron } from 'playwright';
import { DESKTOP_ROOT } from '../../helpers/paths.mjs';

const desktopDir = DESKTOP_ROOT;
const tabId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const gsiUrl = 'https://accounts.google.com/gsi/select?client_id=fixture';
const oauthUrl = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=fixture';
const redirectUrl = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=fixture&mode=redirect';
const failUrl = 'https://accounts.google.com/gsi/fail';
const callbackUrl = 'https://www.linkedin.com/oauth/callback?code=from-popup';
const scriptReturnUrl = 'https://www.linkedin.com/oauth/callback?code=script';
const linkedinUrl = 'https://www.linkedin.com/login';
const docsUrl = 'https://docs.python.org/3/';
const longAuthUrl = 'https://accounts.google.com/o/oauth2/v2/auth?state=' + 'a'.repeat(2500);

let detail = '';
const eventually = async (fn, message) => {
  let last = 'none';
  for (let i = 0; i < 25; i++) {
    try {
      const value = await fn();
      if (value) return value;
      last = JSON.stringify(value);
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise(r => setTimeout(r, 50));
  }
  assert.fail((message || 'Native browser state did not settle') + ' last=' + String(last).slice(0, 300) + ' detail=' + detail.slice(0, 800));
};

test('authentication popups keep their opener, session, and failure fallback', { timeout: 90000 }, async () => {
  assert.ok(longAuthUrl.length > 2048 && longAuthUrl.length < 8192);
  const server = createServer((_req, res) => res.end('<!doctype html><script>window.events=[];window.mawChatGpt.subscribe(s=>events.push(s));</script>'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const data = await mkdtemp(path.join(os.tmpdir(), 'maw-browser-auth-'));
  let app;
  let phase = 'start';
  try {
    app = await electron.launch({
      chromiumSandbox: true,
      executablePath: '/opt/maw-electron/45.2.0/electron',
      args: [desktopDir, '--ozone-platform=x11'],
      env: {
        ...process.env,
        HOME: data,
        MAW_DESKTOP_DATA_DIR: data,
        MAW_DESKTOP_URL: `http://127.0.0.1:${server.address().port}/`,
        MAW_EXTERNAL_POLICY: 'deny',
      },
    });
    const page = await app.firstWindow();
    await page.waitForFunction(() => Array.isArray(window.events), null, { timeout: 10000 });
    await app.evaluate(({ session }, authUrl) => {
      const browser = session.fromPartition('persist:maw-browser');
      const targetLiteral = JSON.stringify(authUrl);
      browser.protocol.handle('https', async (req) => {
        const url = new URL(req.url);
        // protocol.handle does not attach the Cookie header. The partition jar is what a real network request would send.
        const stored = await browser.cookies.get({ url: req.url, name: 'maw_auth_probe' });
        const cookie = [req.headers.get('cookie') || '', ...stored.map(item => item.name + '=' + item.value)].filter(Boolean).join('; ');
        if (cookie.includes('maw_auth_probe=kept')) globalThis.__mawSawAuthCookie = true;
        const marker = `${url.hostname}${url.pathname}:${req.method}`;
        if (url.hostname === 'www.linkedin.com' && url.pathname === '/login') {
          return new Response(`<!doctype html><title>linkedin</title><button id="continue">Continuar como Alexandre</button><script>
            document.getElementById('continue').onclick = () => {
              const target = ${targetLiteral};
              const popup = window.open('about:blank', 'auth', 'width=480,height=640');
              if (!popup) location.assign(target);
              else popup.location = target;
            };
          </script>`, { headers: { 'content-type': 'text/html; charset=utf-8' } });
        }
        if (url.hostname === 'accounts.google.com' && url.pathname === '/gsi/select') {
          return new Response(`<!doctype html><title>${marker}</title><p id="marker">${marker}</p><p id="cookie">${cookie}</p>`, {
            headers: { 'content-type': 'text/html; charset=utf-8' },
          });
        }
        if (url.hostname === 'accounts.google.com' && url.pathname === '/gsi/fail') return Response.error();
        if (url.hostname === 'accounts.google.com' && url.searchParams.get('mode') === 'redirect') {
          return new Response(null, { status: 302, headers: { location: 'https://www.linkedin.com/oauth/callback?code=redirected' } });
        }
        return new Response(`<!doctype html><title>${marker}</title><p id="marker">${marker}</p><p id="cookie">${cookie}</p>`, {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      });
      return browser.cookies.set({
        url: 'https://accounts.google.com/',
        name: 'maw_auth_probe',
        value: 'kept',
        secure: true,
        sameSite: 'lax',
        expirationDate: Math.floor(Date.now() / 1000) + 3600,
      });
    }, gsiUrl);

    const mark = (name) => { phase = name; };
    const limit = (promise, label) => {
      let timer;
      return Promise.race([
        promise,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + ' @ ' + phase)), 2500); }),
      ]).finally(() => clearTimeout(timer));
    };
    const command = payload => limit(page.evaluate(cmd => window.mawChatGpt.command(cmd), payload), 'command');
    const clearEvents = () => limit(page.evaluate(() => { window.events.length = 0; }), 'clear');
    const events = () => limit(page.evaluate(() => window.events.map(event => ({ type: event.type, url: event.url, message: event.message }))), 'events');
    let openerId = 0;
    const tabState = () => limit(app.evaluate(({ webContents, session }, id) => {
      const browser = session.fromPartition('persist:maw-browser');
      const contents = id ? webContents.fromId(id) : webContents.getAllWebContents().find(item => item.session === browser && !item.getURL().startsWith('http://127.0.0.1'));
      if (!contents || contents.isDestroyed()) return null;
      return { id: contents.id, url: contents.getURL() };
    }, openerId), 'tab');
    const popupState = () => limit(app.evaluate(async ({ BrowserWindow, session, webContents }, id) => {
      const popup = BrowserWindow.getAllWindows().find(win => win.getParentWindow());
      if (!popup) return null;
      const url = popup.webContents.getURL();
      const loading = popup.webContents.isLoading();
      if (loading || url === '' || url === 'about:blank') return { url, loading, pending: true, windows: BrowserWindow.getAllWindows().length };
      let inspected;
      try {
        inspected = await Promise.race([
          popup.webContents.executeJavaScript(`({
            marker: document.getElementById('marker')?.textContent || '',
            cookie: document.getElementById('cookie')?.textContent || '',
            jar: document.cookie,
            bridge: typeof window.mawChatGpt,
            opener: !!window.opener
          })`),
          new Promise((_, reject) => setTimeout(() => reject(new Error('js-timeout')), 1000)),
        ]);
      } catch (error) {
        return { url, loading, pending: true, error: String(error), windows: BrowserWindow.getAllWindows().length };
      }
      const prefs = popup.webContents.getLastWebPreferences();
      const { marker, cookie, jar, bridge, opener } = inspected;
      const tab = webContents.fromId(id);
      return {
        url: popup.webContents.getURL(),
        marker,
        cookie,
        jar,
        opener,
        bridge,
        parent: !!popup.getParentWindow(),
        sameSession: popup.webContents.session === session.fromPartition('persist:maw-browser'),
        sandbox: prefs.sandbox,
        nodeIntegration: prefs.nodeIntegration,
        contextIsolation: prefs.contextIsolation,
        webSecurity: prefs.webSecurity,
        preload: prefs.preload || '',
        tabUrl: tab && !tab.isDestroyed() ? tab.getURL() : '',
        tabAlive: !!tab && !tab.isDestroyed(),
        windows: BrowserWindow.getAllWindows().length,
      };
    }, openerId), 'popup');
    const popupUrl = () => limit(app.evaluate(({ BrowserWindow }) => {
      const all = BrowserWindow.getAllWindows();
      const popup = all.find(win => win.getParentWindow());
      if (!popup || popup.isDestroyed()) return { url: '', loading: false, windows: all.length };
      return { url: popup.webContents.getURL(), loading: popup.webContents.isLoading(), windows: all.length };
    }), 'popup-url');
    // Closing a BrowserWindow inside Playwright's evaluate never returns: destroy/close
    // runs the closed handler, then blocks the debugger call. Schedule it and return.
    const closePopup = () => limit(app.evaluate(({ BrowserWindow }) => {
      const popup = BrowserWindow.getAllWindows().find(win => win.getParentWindow());
      if (popup && !popup.isDestroyed()) setImmediate(() => { if (!popup.isDestroyed()) popup.close(); });
      return true;
    }), 'close-popup');
    const fire = (script) => limit(app.evaluate(({ webContents }, payload) => {
      const contents = webContents.fromId(payload.id);
      if (!contents || contents.isDestroyed()) throw new Error('opener missing');
      contents.executeJavaScript(payload.source);
      return true;
    }, { id: openerId, source: script }), 'fire');
    // loadURL does not emit will-navigate. Policy checks have to start in the page.
    const assign = (url) => fire(`setTimeout(() => location.assign(${JSON.stringify(url)}), 0)`);
    const navigate = (url) => limit(app.evaluate(({ webContents }, payload) => {
      const contents = webContents.fromId(payload.id);
      if (!contents || contents.isDestroyed()) throw new Error('opener missing');
      contents.loadURL(payload.url);
      return true;
    }, { id: openerId, url }), 'navigate');
    const run = (script) => limit(app.evaluate(async ({ webContents }, payload) => {
      const contents = webContents.fromId(payload.id);
      if (!contents || contents.isDestroyed()) throw new Error('opener missing');
      try {
        return await Promise.race([
          contents.executeJavaScript(payload.source),
          new Promise((_, reject) => setTimeout(() => reject(new Error('script-timeout')), 2000)),
        ]);
      } catch (error) {
        return 'script-error:' + error.message;
      }
    }, { id: openerId, source: script }), 'run');

    mark('open-linkedin');
    await command({ type: 'open', id: tabId, provider: 'other', url: linkedinUrl });
    await eventually(async () => (await tabState())?.url === linkedinUrl, 'LinkedIn fixture did not load');
    openerId = (await tabState()).id;
    await clearEvents();

    mark('open-popup');
    await app.evaluate(({ webContents }, id) => {
      webContents.fromId(id).executeJavaScript("document.getElementById('continue').click()");
      return true;
    }, openerId);
    await eventually(async () => {
      const state = await popupUrl();
      detail = JSON.stringify(state);
      return !!state.url.startsWith(gsiUrl) && !state.loading;
    }, 'authentication popup did not load');
    const popup = await popupState();
    assert.equal(popup.opener, true);
    assert.equal(popup.cookie.includes('maw_auth_probe=kept') || popup.jar.includes('maw_auth_probe=kept'), true);
    assert.equal(popup.marker.includes('accounts.google.com/gsi/select:GET'), true);
    assert.equal(popup.sameSession, true);
    assert.equal(popup.parent, true);
    assert.equal(popup.sandbox, true);
    assert.equal(popup.nodeIntegration, false);
    assert.equal(popup.contextIsolation, true);
    assert.equal(popup.webSecurity, true);
    assert.equal(popup.preload.includes('preload.cjs'), false);
    assert.equal(popup.bridge, 'undefined');
    assert.equal(popup.tabAlive, true);
    assert.equal(popup.tabUrl, linkedinUrl);
    assert.equal(popup.windows, 2);
    assert.equal((await events()).some(event => event.type === 'open-web-tab'), false);

    mark('return-hop');
    await app.evaluate(({ BrowserWindow }, url) => {
      const popup = BrowserWindow.getAllWindows().find(win => win.getParentWindow());
      popup.webContents.executeJavaScript(`setTimeout(() => location.assign(${JSON.stringify(url)}), 0)`);
      return true;
    }, callbackUrl);
    await eventually(async () => {
      const state = await popupUrl();
      detail = JSON.stringify(state);
      return state.url.startsWith('https://www.linkedin.com/oauth/callback?code=from-popup') && !state.loading;
    }, 'popup did not follow the return hop');
    const returnedPopup = await popupState();
    assert.equal(returnedPopup.opener, true);
    assert.equal(returnedPopup.tabUrl, linkedinUrl);
    assert.equal((await events()).some(event => event.type === 'open-web-tab'), false);

    mark('close-popup');
    await closePopup();
    await eventually(async () => (await popupUrl()).url === '' && (await tabState())?.id === openerId, 'closing the popup destroyed the opener tab');
    assert.equal((await events()).some(event => event.type === 'open-web-tab'), false);

    await clearEvents();
    mark('oauth-get');
    await assign(oauthUrl);
    await eventually(async () => (await tabState())?.url.startsWith(oauthUrl), 'in-document OAuth navigation did not stay in the tab');
    const oauthTab = await tabState();
    assert.equal(oauthTab.id, openerId);
    assert.equal((await popupUrl()).url, '');
    const oauthPage = await limit(app.evaluate(async ({ webContents }, id) => {
      const contents = webContents.fromId(id);
      return Promise.race([
        contents.executeJavaScript('[document.getElementById("marker")?.textContent || "", (document.getElementById("cookie")?.textContent || "") + " " + document.cookie]'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('marker-timeout')), 2000)),
      ]);
    }, openerId), 'oauth-marker');
    assert.equal(oauthPage[0].includes('accounts.google.com/o/oauth2/v2/auth:GET'), true);
    assert.equal(oauthPage[1].includes('maw_auth_probe=kept'), true, 'oauth page lost the browser session cookie');
    assert.equal((await events()).some(event => event.type === 'open-web-tab'), false);

    mark('script-return');
    await assign(scriptReturnUrl);
    await eventually(async () => (await tabState())?.url.startsWith(scriptReturnUrl), 'script return from the identity provider opened a new tab');
    assert.equal((await tabState()).id, openerId);
    assert.equal((await popupUrl()).url, '');
    assert.equal((await events()).some(event => event.type === 'open-web-tab'), false);

    mark('back-linkedin');
    await navigate(linkedinUrl);
    await eventually(async () => (await tabState())?.url === linkedinUrl, 'could not return to LinkedIn');
    await clearEvents();
    await fire(`(() => { const form = document.createElement('form'); form.method = 'POST'; form.action = ${JSON.stringify(oauthUrl)}; const input = document.createElement('input'); input.name = 'client_id'; input.value = 'fixture'; form.appendChild(input); document.body.appendChild(form); form.submit(); })()`);
    await eventually(async () => (await tabState())?.url.startsWith('https://accounts.google.com/o/oauth2/v2/auth'), 'form POST did not stay in the opener');
    const posted = await limit(app.evaluate(async ({ webContents }, id) => {
      const contents = webContents.fromId(id);
      return Promise.race([
        contents.executeJavaScript('document.getElementById("marker")?.textContent || ""'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('marker-timeout')), 2000)),
      ]);
    }, openerId), 'posted-marker');
    assert.equal(posted.includes(':POST'), true);
    assert.equal((await tabState()).id, openerId);
    assert.equal((await popupUrl()).url, '');
    assert.equal((await events()).some(event => event.type === 'open-web-tab'), false);

    mark('back-linkedin');
    await navigate(linkedinUrl);
    await eventually(async () => (await tabState())?.url === linkedinUrl);
    await clearEvents();
    mark('oauth-redirect');
    await assign(redirectUrl);
    await eventually(async () => (await tabState())?.url === 'https://www.linkedin.com/oauth/callback?code=redirected', 'OAuth redirect did not stay in the opener');
    assert.equal((await tabState()).id, openerId);
    assert.equal(await app.evaluate(() => globalThis.__mawSawAuthCookie === true), true);
    assert.equal((await events()).some(event => event.type === 'open-web-tab'), false);

    mark('back-linkedin');
    await navigate(linkedinUrl);
    await eventually(async () => (await tabState())?.url === linkedinUrl);
    await clearEvents();
    mark('docs-tab');
    await assign(docsUrl);
    await eventually(async () => (await tabState())?.url.startsWith(docsUrl), 'ordinary cross-site navigation did not stay in the tab');
    assert.equal((await tabState()).id, openerId);
    assert.equal((await popupUrl()).url, '');
    assert.equal((await events()).some(event => event.type === 'open-web-tab'), false);
    mark('back-linkedin');
    await navigate(linkedinUrl);
    await eventually(async () => (await tabState())?.url === linkedinUrl);

    await clearEvents();
    const longOpen = await run(`window.open(${JSON.stringify(longAuthUrl)}, 'long-auth', 'width=480,height=640') ? 'opened' : 'null'`);
    assert.equal(longOpen, 'opened');
    await eventually(async () => {
      const state = await popupUrl();
      detail = JSON.stringify(state);
      return state.url.startsWith('https://accounts.google.com/o/oauth2/v2/auth?state=aaa') && !state.loading;
    }, 'long authentication URL was blocked');
    assert.equal((await events()).some(event => event.type === 'error' || event.type === 'open-web-tab'), false);
    assert.equal((await tabState()).url, linkedinUrl);

    const second = await run(`window.open(${JSON.stringify(gsiUrl)}, 'second-auth', 'width=480,height=640') ? 'opened' : 'null'`);
    assert.equal(second, 'null');
    await eventually(async () => (await events()).some(event => event.type === 'error' && /system browser/.test(event.message)), 'second sign-in window was not refused');
    assert.equal((await events()).some(event => event.type === 'open-web-tab'), false);
    assert.equal((await popupUrl()).windows, 2);

    const nested = await limit(app.evaluate(async ({ BrowserWindow }, url) => {
      const popupWindow = BrowserWindow.getAllWindows().find(win => win.getParentWindow());
      return Promise.race([
        popupWindow.webContents.executeJavaScript(`window.open(${JSON.stringify(url)}, 'nested', 'width=480,height=640') ? 'opened' : 'null'`),
        new Promise((_, reject) => setTimeout(() => reject(new Error('nested-timeout')), 2000)),
      ]);
    }, gsiUrl), 'nested');
    assert.equal(nested, 'null');
    await eventually(async () => (await events()).filter(event => event.type === 'error').length >= 2, 'nested sign-in window was not refused');
    assert.equal((await popupUrl()).windows, 2);
    assert.equal((await events()).some(event => event.type === 'open-web-tab'), false);

    await closePopup();
    await eventually(async () => (await popupUrl()).url === '');
    await clearEvents();
    const docsPopup = await run(`window.open(${JSON.stringify(docsUrl)}, 'docs', 'width=480,height=640') ? 'opened' : 'null'`);
    assert.equal(docsPopup, 'opened');
    await eventually(async () => (await popupUrl()).url === docsUrl && !(await popupUrl()).loading, 'ordinary popup was converted into a workspace tab');
    assert.equal((await events()).some(event => event.type === 'open-web-tab'), false);
    assert.equal((await tabState()).url, linkedinUrl);
    await closePopup();
    await eventually(async () => (await popupUrl()).url === '');

    await clearEvents();
    await command({ type: 'browser-action', id: tabId, action: 'open-link', url: gsiUrl });
    await eventually(async () => (await tabState())?.url.startsWith(gsiUrl), 'context-menu sign-in link became a workspace tab');
    assert.equal((await tabState()).id, openerId);
    assert.equal((await popupUrl()).url, '');
    assert.equal((await events()).some(event => event.type === 'open-web-tab'), false);

    mark('back-linkedin');
    await navigate(linkedinUrl);
    await eventually(async () => (await tabState())?.url === linkedinUrl);
    await clearEvents();
    const failedOpen = await run(`window.open(${JSON.stringify(failUrl)}, 'fail', 'width=480,height=640') ? 'opened' : 'null'`);
    assert.equal(failedOpen, 'opened');
    await eventually(async () => (await popupUrl()).url === '' && (await events()).some(event => event.type === 'error' && /system browser/.test(event.message)), 'failed authentication popup was not handed to the system browser');
    assert.equal((await tabState()).id, openerId);
    assert.equal((await tabState()).url, linkedinUrl);
    assert.equal((await events()).some(event => event.type === 'open-web-tab'), false);

    await clearEvents();
    mark('tab-fail');
    await assign(failUrl);
    await eventually(async () => (await events()).some(event => event.type === 'error' && /system browser|failed to load/.test(event.message)), 'failed in-tab sign-in had no fallback');
    assert.equal((await popupUrl()).url, '');
    assert.equal((await events()).some(event => event.type === 'open-web-tab'), false);
    const cookies = await app.evaluate(({ session }) => session.fromPartition('persist:maw-browser').cookies.get({ name: 'maw_auth_probe' }));
    assert.equal(cookies[0]?.value, 'kept');
    const otherPartition = await app.evaluate(({ session }) => session.fromPartition('persist:maw-chatgpt').cookies.get({ name: 'maw_auth_probe' }));
    assert.equal(otherPartition.length, 0);
  } catch (error) {
    console.log('failed during', phase);
    throw error;
  } finally {
    if (app) {
      const closed = app.close().then(() => true, () => false);
      const finished = await Promise.race([closed, new Promise(resolve => setTimeout(() => resolve(false), 5000))]);
      if (!finished) { try { app.process().kill('SIGKILL'); } catch {} }
    }
    await new Promise(resolve => server.close(resolve));
    await rm(data, { recursive: true, force: true });
  }
});
