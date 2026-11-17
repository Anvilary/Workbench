import { app, BrowserWindow, WebContentsView, Menu, ipcMain, session, shell, dialog, clipboard, ClipboardItem } from 'electron';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, lstat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { PARTITION, GITHUB_PARTITION, PERPLEXITY_PARTITION, BROWSER_PARTITION, otherUrl, CHANNEL, serviceUrl, trustedSender, validCommand, nativeBounds, nativeBoundsForRect, embeddedUrl, externalUrl, isDownloadOrFileDeliveryUrl, chatUrl, githubEmbeddedUrl, perplexityUrl, perplexityEmbeddedUrl, targetWebProvider, isSameSite, authenticationUrl, decideWindowOpen, getBrowserZoomAction } from './policy.mjs';
import { fileClipboardPayload, resolveClipboardTarget } from './file-clipboard.mjs';
import { calculateResourceBudget, selectEvictionCandidate, isProtectedProvider, readSystemMemory } from './resource-budget.mjs';
import { ResourceCollector } from './resource-monitor.mjs';
import { browserDownloadHandler } from './browser-downloads.mjs';
import { isAllowedWebAuthnOrigin, isValidRpId, generateClientData, parseFido2AssertOutput, classifyWebAuthnError } from './webauthn-policy.mjs';
import { isFido2ToolsAvailable, discoverFido2Devices, getDeviceCapabilities, executeAssertion } from './webauthn-backend.mjs';
import { requestPinDialog } from './webauthn-dialog.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
// Deliberately distinct from both production MAW and any Brave/Neko profile.
app.setPath('userData', path.resolve(process.env.MAW_DESKTOP_DATA_DIR || path.join(app.getPath('appData'), 'maw-desktop-prototype')));
app.setName(process.env.MAW_DESKTOP_PRODUCTION === '1' ? 'My Amazing Workspace' : 'MAW ChatGPT Prototype');
if (process.platform === 'linux') app.setDesktopName('maw.desktop');
if (app.commandLine.hasSwitch('no-sandbox')) throw new Error('MAW desktop requires Chromium sandboxing');
app.enableSandbox();
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-webgl');
app.commandLine.appendSwitch('disable-accelerated-video-decode');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
if (!process.env.DRI_PRIME) process.env.DRI_PRIME = '0';
if (!process.env.VK_DRIVER_FILES && !process.env.VK_ICD_FILENAMES && existsSync('/usr/share/vulkan/icd.d/radeon_icd.json')) {
  process.env.VK_DRIVER_FILES = '/usr/share/vulkan/icd.d/radeon_icd.json';
}
let local = serviceUrl(process.env.MAW_DESKTOP_URL || '');
delete process.env.MAW_DESKTOP_URL;
if (!app.requestSingleInstanceLock({ serviceUrl: local.href })) app.exit(0);

export function isOAuthLoopbackCallback(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u0020\u007f]/.test(value)) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' || url.username || url.password) return false;
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') return false;
    const hasCode = url.searchParams.has('code');
    const hasError = url.searchParams.has('error');
    if (!hasCode && !hasError) return false;
    const normPath = url.pathname.toLowerCase().replace(/\/+$/, '');
    const isCallbackPath = normPath === '/callback' || normPath.endsWith('/callback') ||
      normPath === '/oauth/callback' || normPath.endsWith('/oauth/callback') ||
      normPath === '/auth/callback' || normPath.endsWith('/auth/callback');
    if (!isCallbackPath && !hasCode) return false;
    return true;
  } catch {
    return false;
  }
}

// Do not await app.whenReady() at module scope: Electron waits for ESM
// evaluation before emitting ready, which would deadlock initialization.
async function start() {
  await mkdir(app.getPath('userData'), { recursive: true, mode: 0o700 });
  await app.whenReady();
  Menu.setApplicationMenu(null);
  const isWebAuthnEnabled = process.env.MAW_WEBAUTHN_ENABLED !== '0';
  const webauthnPreload = path.join(here, 'webauthn-preload.cjs');
  const secure = { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: false, allowRunningInsecureContent: false };
  const chatSession = session.fromPartition(PARTITION);
  const githubSession = session.fromPartition(GITHUB_PARTITION);
  const perplexitySession = session.fromPartition(PERPLEXITY_PARTITION);
  const browserSession = session.fromPartition(BROWSER_PARTITION);
  const isInteractivePermission = (permission) => permission === 'fullscreen' || permission === 'pointerLock' || permission === 'speaker-selection';

  browserSession.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(isInteractivePermission(permission) || permission === 'clipboard-sanitized-write');
  });
  browserSession.setPermissionCheckHandler((_contents, permission) => {
    return isInteractivePermission(permission) || permission === 'automatic-fullscreen' || permission === 'clipboard-sanitized-write';
  });
  browserSession.webRequest.onBeforeRequest((details, callback) => {
    // Block direct local-network URLs, including subframes and fetches, in general web pages.
    const network = /^(https?|wss?):/.test(details.url);
    const checked = details.url.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:');
    callback({ cancel: network && !otherUrl(checked, 8192) && !(details.url.startsWith('https:') && authenticationUrl(details.url)) });
  });
  // Permit clipboard writing only from the official ChatGPT origin.
  // Clipboard reading and all unrelated permissions remain denied.
  const canWriteClipboard = (contents, requestingUrl) => {
    try {
      return !!contents &&
        new URL(contents.getURL()).origin === 'https://chatgpt.com' &&
        new URL(requestingUrl).origin === 'https://chatgpt.com';
    } catch {
      return false;
    }
  };

  chatSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    if (permission === 'media' && details?.mediaTypes?.includes('audio') && !details?.mediaTypes?.includes('video')) {
      try {
        const origin = contents ? new URL(contents.getURL()).origin : '';
        const reqOrigin = details?.requestingUrl ? new URL(details.requestingUrl).origin : '';
        if (origin === 'https://chatgpt.com' && reqOrigin === 'https://chatgpt.com') {
          callback(true);
          return;
        }
      } catch {}
    }
    callback(
      isInteractivePermission(permission) ||
      (permission === 'clipboard-sanitized-write' && canWriteClipboard(contents, details?.requestingUrl))
    );
  });

  chatSession.setPermissionCheckHandler((contents, permission, requestingOrigin) => {
    if (permission === 'media') {
      try {
        const origin = contents ? new URL(contents.getURL()).origin : '';
        const reqOrigin = requestingOrigin ? new URL(requestingOrigin).origin : '';
        return origin === 'https://chatgpt.com' && reqOrigin === 'https://chatgpt.com';
      } catch { return false; }
    }
    return isInteractivePermission(permission) ||
      permission === 'automatic-fullscreen' ||
      (permission === 'clipboard-sanitized-write' && canWriteClipboard(contents, requestingOrigin));
  });
  const githubClipboard = (contents, requestingUrl) => {
    try {
      return !!contents &&
        new URL(contents.getURL()).origin === 'https://github.com' &&
        new URL(requestingUrl).origin === 'https://github.com';
    } catch { return false; }
  };
  githubSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(
      isInteractivePermission(permission) ||
      (permission === 'clipboard-sanitized-write' && githubClipboard(contents, details?.requestingUrl))
    );
  });
  githubSession.setPermissionCheckHandler((contents, permission, requestingOrigin) =>
    isInteractivePermission(permission) ||
    permission === 'automatic-fullscreen' ||
    (permission === 'clipboard-sanitized-write' && githubClipboard(contents, requestingOrigin))
  );
  const perplexityClipboard = (contents, requestingUrl) => {
    try {
      if (!contents) return false;
      const origin = new URL(contents.getURL()).origin;
      const reqOrigin = new URL(requestingUrl).origin;
      const allowedOrigins = ['https://www.perplexity.ai', 'https://perplexity.ai'];
      return allowedOrigins.includes(origin) && allowedOrigins.includes(reqOrigin);
    } catch { return false; }
  };
  perplexitySession.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(
      isInteractivePermission(permission) ||
      (permission === 'clipboard-sanitized-write' && perplexityClipboard(contents, details?.requestingUrl))
    );
  });
  perplexitySession.setPermissionCheckHandler((contents, permission, requestingOrigin) =>
    isInteractivePermission(permission) ||
    permission === 'automatic-fullscreen' ||
    (permission === 'clipboard-sanitized-write' && perplexityClipboard(contents, requestingOrigin))
  );

  const iconPath = path.join(here, 'icon.png');
  const win = new BrowserWindow({ width: 1280, height: 860, title: 'MAW · ChatGPT feasibility prototype', autoHideMenuBar: true,
    backgroundColor: '#0e0e10',
    icon: iconPath,
    webPreferences: { ...secure, partition: 'persist:maw-shell-prototype', preload: path.join(here, 'preload.cjs') } });
  const views = new Map();
  const urls = new Map();
  const providers = new Map();
  const requestedUrls = new Map();
  const failures = new Map();
  let layoutFocusedId = null;
  // Native clicks must not make an unchanged renderer layout look like a new focus request.
  let reportedFocusedId = null;
  const popups = new Set();
  const popupOwners = new Map(); // popup WebContents -> tabId
  const authEntryUrls = new WeakMap(); // WebContents -> relying-party URL before sign-in
  const attachedViews = new Map(); // id -> WebContentsView (up to 4 simultaneously visible)
  const suspendedTabs = new Map(); // id -> { id, provider, url, requestedUrl, zoomLevel, suspendedAt }
  const lastAccessedAt = new Map(); // id -> number (timestamp)
  const activeDownloads = new Map(); // id -> number (count)
  const interactionProtected = new Set();
  const zoomLevels = new Map(); // id -> number
  let shuttingDown = false;
  let pendingShellStorage = null;
  const send = state => { if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(CHANNEL + ':state', state); };
  const linkOpenHistory = new Map();
  function allowLinkOpen(tabId) {
    const now = Date.now();
    const history = (linkOpenHistory.get(tabId) || []).filter(t => now - t < 2000);
    if (history.length >= 5) return false;
    history.push(now);
    linkOpenHistory.set(tabId, history);
    return true;
  }

  const resourceCollector = new ResourceCollector({
    app,
    win,
    views,
    providers,
    urls,
    attachedViews,
    suspendedTabs,
    getBackendReadiness: discoverBackendReadiness,
    onState: (snapshot) => {
      send({ type: 'performance-update', snapshot });
    },
  });

  const browserSessions = { chatgpt: chatSession, github: githubSession, perplexity: perplexitySession, other: browserSession };
  for (const [provider, browser] of Object.entries(browserSessions)) {
    browser.on('will-download', browserDownloadHandler({
      provider, views, providers, popupOwners, popups, activeDownloads,
      allowedOrigin: (value) => {
        try {
          const url = new URL(value);
          if (provider === 'chatgpt') return chatUrl(url.origin);
          if (provider === 'perplexity') return ['https://perplexity.ai', 'https://www.perplexity.ai'].includes(url.origin);
          if (provider === 'github') return url.protocol === 'https:' && (url.hostname === 'github.com' || url.hostname.endsWith('.github.com') || url.hostname.endsWith('.githubusercontent.com'));
          return otherUrl(value);
        } catch { return false; }
      },
      allowedDestination: (value) => {
        if (provider === 'chatgpt') return isDownloadOrFileDeliveryUrl(value) || chatUrl(value);
        if (provider === 'other' && value.startsWith('blob:')) return otherUrl(value.slice(5));
        return navigationAllowed(provider, value);
      },
      windowForContents: (contents) => BrowserWindow.fromWebContents(contents),
      downloadsDirectory: () => app.getPath('downloads'),
      autoSave: () => process.env.MAW_DOWNLOAD_AUTO_SAVE === '1',
      send,
      ready: (id) => {
        const contents = views.get(id)?.webContents;
        if (contents && !contents.isDestroyed() && !contents.isLoading() && !failures.has(id) && durablePage(providers.get(id), contents.getURL())) send({ type: 'ready', id });
        trimCapacity();
      },
    }));
  }

  function hideAll() {
    for (const [id, view] of attachedViews) {
      if (!win.isDestroyed() && !view.webContents.isDestroyed()) {
        try { win.contentView.removeChildView(view); } catch {}
        try { view.setVisible(false); } catch {}
      }
    }
    attachedViews.clear();
  }

  function hide(id) {
    if (id) {
      const view = attachedViews.get(id);
      if (view) {
        if (!win.isDestroyed() && !view.webContents.isDestroyed()) {
          try { win.contentView.removeChildView(view); } catch {}
          try { view.setVisible(false); } catch {}
        }
        attachedViews.delete(id);
      }
    } else {
      hideAll();
    }
  }


  function invalidate() { hideAll(); send({ type: 'layout-needed' }); }

  async function openExternal(url, reason) {
    if (!(externalUrl(url) || authenticationUrl(url)) || win.isDestroyed()) return;
    if (process.env.MAW_EXTERNAL_POLICY === 'deny') {
      send({ type: 'error', message: reason || 'External browser opening was cancelled.' });
      return;
    }
    hideAll();
    const answer = await dialog.showMessageBox(win, { type: 'question', message: reason || 'Open this destination in your browser?', detail: new URL(url).origin, buttons: ['Cancel', 'Open browser'], defaultId: 0, cancelId: 0 });
    if (answer.response === 1) await shell.openExternal(url);
    send({ type: 'layout-needed' });
  }

  function navigationAllowed(provider, url) {
    if (provider === 'other') return otherUrl(url);
    if (provider === 'github') return githubEmbeddedUrl(url);
    if (provider === 'perplexity') return perplexityEmbeddedUrl(url);
    return embeddedUrl(url);
  }

  function applyBrowserZoom(id, contents, action) {
    if (!contents || contents.isDestroyed()) return;
    let lvl = contents.getZoomLevel();
    if (action === 'zoom-in') {
      lvl = Math.min(3, Math.round((lvl + 0.5) * 10) / 10);
    } else if (action === 'zoom-out') {
      lvl = Math.max(-3, Math.round((lvl - 0.5) * 10) / 10);
    } else if (action === 'zoom-reset') {
      lvl = 0;
    } else {
      return;
    }
    contents.setZoomLevel(lvl);
    zoomLevels.set(id, lvl);
    let factor;
    try {
      factor = contents.getZoomFactor();
    } catch {
      factor = Math.pow(1.2, lvl);
    }
    if (!Number.isFinite(factor) || factor <= 0) {
      factor = Math.pow(1.2, lvl);
    }
    const percentage = Math.round(factor * 100);
    send({ type: 'browser-zoom', id, zoomFactor: factor, percentage });
  }

  function guard(contents, provider = 'chatgpt', allowPopup = true) {
    const getTabId = () => [...views.entries()].find(([, v]) => v.webContents === contents)?.[0] || popupOwners.get(contents);
    const isAuthFlow = () => {
      if (!allowPopup || popupOwners.has(contents)) return true;
      try {
        const parentWin = BrowserWindow.fromWebContents(contents);
        if (parentWin && popups.has(parentWin)) return true;
      } catch {}
      if (authEntryUrls.has(contents)) return true;
      let currentUrl = '';
      try { currentUrl = contents.getURL() || ''; } catch {}
      if (currentUrl && (authenticationUrl(currentUrl) || authEntryUrls.has(contents))) return true;
      if (provider === 'chatgpt' || provider === 'github' || provider === 'perplexity') return true;
      return false;
    };
    const handleFileDelivery = (event, url) => {
      if (provider === 'chatgpt' && isDownloadOrFileDeliveryUrl(url)) {
        event.preventDefault();
        contents.downloadURL(url);
        return true;
      }
      return false;
    };
    const isSameSiteOrAllowed = (url) => {
      // Sign-in stays in this browsing context. A workspace tab has no opener,
      // drops a form body, and leaves the provider document empty.
      let currentUrl = '';
      try { currentUrl = contents.getURL() || ''; } catch { currentUrl = ''; }
      if (authenticationUrl(url)) {
        if (!authEntryUrls.has(contents) && currentUrl && currentUrl !== 'about:blank' && !authenticationUrl(currentUrl)) authEntryUrls.set(contents, currentUrl);
        return true;
      }
      // Leave the identity provider only for the site that started sign-in, or the popup opener.
      if (authenticationUrl(currentUrl) && navigationAllowed(provider, url)) {
        if (provider !== 'other') return true;
        const entry = authEntryUrls.get(contents) || '';
        if (entry && isSameSite(entry, url)) return true;
        const openerId = getTabId();
        const opener = openerId ? views.get(openerId)?.webContents : null;
        if (opener && opener !== contents && !opener.isDestroyed()) {
          try { if (isSameSite(opener.getURL(), url)) return true; } catch { /* opener is gone */ }
        }
      }
      if (provider === 'other') {
        if (!currentUrl || currentUrl === 'about:blank' || urls.get(getTabId()) === url) return otherUrl(url);
        return otherUrl(url) && isSameSite(currentUrl, url);
      }
      return navigationAllowed(provider, url);
    };
    const navigation = (event, url, isInPlace, isMainFrame) => {
      if (isMainFrame === false) return;
      if (handleFileDelivery(event, url)) return;
      if (isOAuthLoopbackCallback(url) && isAuthFlow()) {
        event.preventDefault();
        void shell.openExternal(url).catch(() => {});
        return;
      }
      if (isSameSiteOrAllowed(url)) return;
      event.preventDefault();
      const id = getTabId();
      if (id && targetWebProvider(url)) {
        if (allowLinkOpen(id)) {
          send({ type: 'open-web-tab', sourceTabId: id, url });
        }
        return;
      }
      void openExternal(url).catch(() => send({ type: 'error', message: 'Could not open external browser.' }));
    };
    const redirect = (event, url, isInPlace, isMainFrame) => {
      if (isMainFrame === false) return;
      if (handleFileDelivery(event, url)) return;
      if (isOAuthLoopbackCallback(url) && isAuthFlow()) {
        event.preventDefault();
        void shell.openExternal(url).catch(() => {});
        return;
      }
      if (navigationAllowed(provider, url) || authenticationUrl(url)) return;
      event.preventDefault();
      void openExternal(url).catch(() => send({ type: 'error', message: 'Could not open external browser.' }));
    };
    contents.on('will-navigate', navigation);
    contents.on('will-redirect', redirect);
    contents.on('will-attach-webview', event => event.preventDefault());
    const popupWindow = () => ({ action: 'allow', overrideBrowserWindowOptions: {
      parent: win, autoHideMenuBar: true, width: 640, height: 760,
      webPreferences: { ...secure, session: browserSessions[provider] ?? chatSession, preload: isWebAuthnEnabled && provider === 'chatgpt' ? webauthnPreload : '', backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required', webgl: true },
    } });
    contents.setWindowOpenHandler(({ url, disposition, features }) => {
      if (provider === 'chatgpt' && isDownloadOrFileDeliveryUrl(url)) {
        contents.downloadURL(url);
        return { action: 'deny' };
      }
      if (isOAuthLoopbackCallback(url) && isAuthFlow()) {
        void shell.openExternal(url).catch(() => {});
        return { action: 'deny' };
      }
      const decision = decideWindowOpen({
        url, disposition, features, allowPopup, popupOpen: popups.size >= 1,
        permitted: navigationAllowed(provider, url),
        tabbable: !!(getTabId() && targetWebProvider(url)),
        external: externalUrl(url) || authenticationUrl(url),
      });
      if (decision === 'popup') return popupWindow();
      if (decision === 'tab') {
        const id = getTabId();
        if (id && allowLinkOpen(id)) send({ type: 'open-web-tab', sourceTabId: id, url });
        return { action: 'deny' };
      }
      if (decision === 'external') {
        const reason = authenticationUrl(url) ? 'This sign-in cannot continue inside the workspace. Open it in your system browser?' : undefined;
        void openExternal(url, reason).catch(() => send({ type: 'error', message: 'Could not open external browser.' }));
      }
      return { action: 'deny' };
    });
    contents.on('did-create-window', popup => {
      popups.add(popup);
      // Capture the contents now. After 'closed', popup.webContents throws
      // "Object has been destroyed" and would skip removing this popup.
      const popupContents = popup.webContents;
      const tabId = getTabId();
      if (tabId) popupOwners.set(popupContents, tabId);
      popup.setMenu(null);
      guard(popupContents, provider, false);
      let authLoadFailed = false;
      popupContents.on('did-fail-load', (_event, code, _description, failedUrl, isMainFrame) => {
        if (authLoadFailed || !isMainFrame || code === -3 || !authenticationUrl(failedUrl)) return;
        authLoadFailed = true;
        if (!popup.isDestroyed()) popup.close();
        void openExternal(failedUrl, 'This sign-in could not be opened inside MAW. Open it in your system browser?').catch(() => {});
      });
      popup.on('closed', () => {
        popupOwners.delete(popupContents);
        popups.delete(popup);
        invalidate();
      });
    });
    contents.on('before-input-event', (event, input) => {
      const id = getTabId();
      if (id && input.type === 'keyDown') interactionProtected.add(id);
      if (input.type === 'keyDown' && input.control && input.key.toLowerCase() === 'l') {
        event.preventDefault(); send({ type: 'address-shortcut', id }); return;
      }
      const zoomAction = getBrowserZoomAction(input);
      if (zoomAction && id) {
        event.preventDefault();
        applyBrowserZoom(id, contents, zoomAction);
        return;
      }
      desktopShortcut(event, input);
    });
    contents.on('context-menu', (event, params) => {
      if (typeof event.preventDefault === 'function') event.preventDefault();
      const id = [...views.entries()].find(([, view]) => view.webContents === contents)?.[0];
      if (!id) return;
      send({
        type: 'browser-context',
        id,
        selection: typeof params.selectionText === 'string' && params.selectionText.length > 0,
        linkURL: typeof params.linkURL === 'string' ? params.linkURL : '',
        canGoBack: contents.canGoBack(),
        canGoForward: contents.canGoForward(),
        x: Number.isFinite(params.x) ? params.x : 0,
        y: Number.isFinite(params.y) ? params.y : 0,
      });
    });
  }

  function desktopShortcut(event, input) {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F11') { event.preventDefault(); win.setFullScreen(!win.isFullScreen()); }
    if (input.control && (input.key === 'Tab' || input.key === 'PageUp' || input.key === 'PageDown')) {
      event.preventDefault(); send({ type: 'tab-shortcut', direction: input.shift || input.key === 'PageUp' ? -1 : 1 });
    }
    if (input.control && input.key.toLowerCase() === 'w') { event.preventDefault(); send({ type: 'close-shortcut' }); }
  }

  function chatUrlForPersistence(value) {
    try {
      const url = new URL(value);
      return url.origin === 'https://chatgpt.com' && !/^\/(api|auth)(\/|$)/.test(url.pathname) &&
        ![...url.searchParams.keys()].some(key => /token|code|state|session/i.test(key));
    } catch { return false; }
  }

  function durablePage(provider, value) {
    if (provider === 'other') {
      try {
        const url = new URL(value);
        return otherUrl(value) && !/^\/(api|auth)(\/|$)/.test(url.pathname) && ![...url.searchParams.keys()].some(key => /token|code|state|session/i.test(key));
      } catch { return false; }
    }
    if (provider === 'github') {
      try {
        const url = new URL(value);
        return url.origin === 'https://github.com' && ![...url.searchParams.keys()].some(key => /token|code|state|session/i.test(key));
      } catch { return false; }
    }
    if (provider === 'perplexity') {
      try {
        const url = new URL(value);
        return perplexityUrl(value) && !/^\/(api|auth)(\/|$)/.test(url.pathname) &&
          ![...url.searchParams.keys()].some(key => /token|code|state|session/i.test(key));
      } catch { return false; }
    }
    return chatUrlForPersistence(value);
  }

  function canEvict(id) {
    if (attachedViews.has(id)) return false;
    if (layoutFocusedId === id) return false;
    if ((activeDownloads.get(id) ?? 0) > 0) return false;
    for (const ownerId of popupOwners.values()) {
      if (ownerId === id) return false;
    }
    const view = views.get(id);
    if (!view || view.webContents.isDestroyed()) return false;
    if (view.webContents.isLoading()) return false;

    // A budget is soft when a page may hold unsaved input. Never trade drafts for RAM.
    if (interactionProtected.has(id) || isProtectedProvider(providers.get(id) ?? 'chatgpt')) return false;
    if (!durablePage(providers.get(id), view.webContents.getURL())) return false;

    return true;
  }

  function getResourceBudgetInfo() {
    let tabWorkingSetBytes = 0;
    try {
      if (typeof app.getAppMetrics === 'function') {
        const metrics = app.getAppMetrics();
        for (const m of metrics) {
          if (m.type === 'Tab' && m.memory?.workingSetSize) {
            tabWorkingSetBytes += m.memory.workingSetSize * 1024;
          }
        }
      }
    } catch {}

    const { freeBytes, availableBytes, totalBytes } = readSystemMemory();

    return calculateResourceBudget({
      freeBytes,
      availableBytes,
      totalBytes,
      tabWorkingSetBytes,
      attachedCount: attachedViews.size,
      envOverride: process.env.MAW_MAX_RESIDENT_VIEWS,
      tierOverride: process.env.MAW_MEMORY_PRESSURE_TIER,
    });
  }

  function evictTab(id) {
    const view = views.get(id);
    if (!view) return;

    let currentUrl = urls.get(id) || requestedUrls.get(id);
    try {
      if (!view.webContents.isDestroyed()) {
        const activeUrl = view.webContents.getURL();
        if (durablePage(providers.get(id) ?? 'chatgpt', activeUrl)) {
          currentUrl = activeUrl;
        }
      }
    } catch {}

    const provider = providers.get(id) ?? 'chatgpt';
    const zoomLevel = zoomLevels.get(id) ?? 0;

    suspendedTabs.set(id, {
      id,
      provider,
      url: currentUrl,
      requestedUrl: requestedUrls.get(id) || currentUrl,
      zoomLevel,
      suspendedAt: Date.now(),
      history: { entries: view.webContents.navigationHistory.getAllEntries(), index: view.webContents.navigationHistory.getActiveIndex() },
    });

    hide(id);
    if (!view.webContents.isDestroyed()) {
      view.webContents.close();
    }
    views.delete(id);
    urls.delete(id);
    requestedUrls.delete(id);
    failures.delete(id);

    send({ type: 'suspended', id });
  }

  function trimCapacity(excludeId, reserve = 0) {
    const { budget } = getResourceBudgetInfo();
    while (views.size > Math.max(0, budget - reserve)) {
      const candidateId = selectEvictionCandidate({
        residentIds: views.keys(),
        lastAccessedAt,
        canEvict,
        isProtected: (id) => isProtectedProvider(providers.get(id) ?? 'chatgpt'),
        excludeId,
      });

      if (!candidateId) break;
      evictTab(candidateId);
    }
  }

  function open(id, url, provider = 'chatgpt', explicit = true) {
    const providerName = provider === 'other' ? 'Browser' : provider === 'github' ? 'GitHub' : provider === 'perplexity' ? 'Perplexity' : 'ChatGPT';
    const targetSession = browserSessions[provider] ?? chatSession;
    if (views.has(id)) {
      lastAccessedAt.set(id, Date.now());
      if ((providers.get(id) ?? 'chatgpt') !== provider) {
        send({ type: 'error', id, message: 'This tab cannot change browser provider.' });
        return;
      }
      const contents = views.get(id).webContents;
      if (contents.isDestroyed()) {
        closeView(id);
      } else if (failures.has(id)) {
        if (explicit) {
          closeView(id);
        } else {
          send({ type: 'error', id, message: failures.get(id) || `${providerName} renderer stopped. Use Reload page to retry.` });
          return;
        }
      } else {
        if (!explicit && requestedUrls.get(id) !== url) {
          requestedUrls.set(id, url);
          if (urls.get(id) !== url && contents.getURL() !== url) {
            urls.set(id, url);
            void contents.loadURL(url).catch(() => {});
          }
        } else if (!contents.isLoading() && !durablePage(provider, contents.getURL())) {
          void contents.loadURL(url).catch(() => {});
        }
        if (!contents.isLoading() && durablePage(provider, contents.getURL())) {
          send({ type: 'ready', id });
          reportNavigation(id);
          if (urls.get(id) !== contents.getURL() || contents.getURL() !== url) {
            urls.set(id, contents.getURL());
            send({ type: 'committed', id, url: contents.getURL() });
          }
        }
        return;
      }
    }

    let targetUrl = url;
    let initialZoom = 0;
    let history = null;
    if (suspendedTabs.has(id)) {
      const suspended = suspendedTabs.get(id);
      suspendedTabs.delete(id);
      if (suspended) {
        if (durablePage(provider, suspended.url)) {
          targetUrl = suspended.url;
        }
        initialZoom = suspended.zoomLevel ?? 0;
        history = suspended.history ?? null;
        send({ type: 'restoring', id });
      }
    }

    trimCapacity(id, 1);
    const viewPreload = isWebAuthnEnabled && provider === 'chatgpt' ? webauthnPreload : '';
    const view = new WebContentsView({ webPreferences: { ...secure, session: targetSession, preload: viewPreload, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required', webgl: true } });
    view.setVisible(false);
    view.setBackgroundColor('#212121');
    views.set(id, view);
    providers.set(id, provider);
    urls.set(id, targetUrl);
    requestedUrls.set(id, targetUrl);
    lastAccessedAt.set(id, Date.now());
    if (initialZoom !== 0) {
      zoomLevels.set(id, initialZoom);
    }
    guard(view.webContents, provider);
    const reportFocus = () => {
      lastAccessedAt.set(id, Date.now());
      if (views.get(id) !== view || attachedViews.get(id) !== view ||
          view.webContents.isDestroyed() || reportedFocusedId === id) return;
      reportedFocusedId = id;
      send({ type: 'focused', id });
    };
    // Observe native pointer activation without cancelling page input. Bare focus events
    // also occur during attachment and programmatic focus, so they are not user intent.
    view.webContents.on('before-mouse-event', (_event, mouse) => {
      if (mouse.type === 'mouseDown') { interactionProtected.add(id); reportFocus(); }
    });
    const committed = (_event, url, isMainFrame = true) => {
      if (!isMainFrame) return;
      reportNavigation(id);
      if (!durablePage(provider, url)) return;
      urls.set(id, url);
      send({ type: 'committed', id, url });
    };
    view.webContents.on('did-navigate', (event, url) => { interactionProtected.delete(id); committed(event, url); });
    view.webContents.on('did-navigate-in-page', committed);
    view.webContents.on('did-start-loading', () => { failures.delete(id); send({ type: 'loading', id }); });
    view.webContents.on('did-finish-load', () => {
      if (initialZoom !== 0 && !view.webContents.isDestroyed()) {
        try { view.webContents.setZoomLevel(initialZoom); } catch {}
      }
      if (!failures.has(id) && durablePage(provider, view.webContents.getURL())) send({ type: 'ready', id });
    });
    view.webContents.on('did-stop-loading', () => {
      if (views.get(id) !== view) return;
      if (!failures.has(id) && durablePage(provider, view.webContents.getURL())) send({ type: 'ready', id });
      reportNavigation(id);
      trimCapacity(id);
    });
    view.webContents.on('did-fail-load', (_event, code, _description, failedUrl, mainFrame) => {
      if (!mainFrame) return;
      if (code === -3) {
        if (!failures.has(id) && durablePage(provider, view.webContents.getURL())) send({ type: 'ready', id });
        return;
      }
      if (authenticationUrl(failedUrl)) {
        void openExternal(failedUrl, 'This sign-in could not be opened inside MAW. Open it in your system browser?').catch(() => {});
      }
      const message = `${providerName} failed to load (${code}). Use Reload page to retry.`;
      failures.set(id, message);
      send({ type: 'error', id, message });
    });
    view.webContents.on('render-process-gone', () => {
      const message = `${providerName} renderer stopped. Use Reload page to retry.`;
      failures.set(id, message);
      if (attachedViews.has(id)) hide(id);
      send({ type: 'error', id, message });
    });
    if (history?.entries?.length) {
      void view.webContents.navigationHistory.restore(history).catch(() => {
        if (!view.webContents.isDestroyed()) void view.webContents.loadURL(targetUrl).catch(() => {});
      });
    } else void view.webContents.loadURL(targetUrl).catch(() => {});
  }

  function closeView(id) {
    suspendedTabs.delete(id);
    interactionProtected.delete(id);
    lastAccessedAt.delete(id);
    zoomLevels.delete(id);
    activeDownloads.delete(id);
    const view = views.get(id);
    if (view) {
      hide(id);
      if (!view.webContents.isDestroyed()) view.webContents.close();
    }
    views.delete(id); urls.delete(id); providers.delete(id); requestedUrls.delete(id); failures.delete(id);
  }

  function reportNavigation(id) {
    const contents = views.get(id)?.webContents;
    if (!contents || contents.isDestroyed()) return;
    const current = contents.getURL();
    if (!(navigationAllowed(providers.get(id), current) || authenticationUrl(current))) return;
    send({ type: 'navigation', id, url: current, canGoBack: contents.navigationHistory.canGoBack(), canGoForward: contents.navigationHistory.canGoForward() });
  }

  async function discoverBackendReadiness() {
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    let file;
    if (process.env.MAW_RUNTIME_DIR) {
      file = path.join(process.env.MAW_RUNTIME_DIR, 'maw-ready.json');
    } else if (process.env.XDG_RUNTIME_DIR) {
      file = path.join(process.env.XDG_RUNTIME_DIR, 'maw', 'maw-ready.json');
    } else if (uid !== null && existsSync(`/run/user/${uid}`)) {
      file = path.join(`/run/user/${uid}`, 'maw', 'maw-ready.json');
    } else {
      file = path.join(os.tmpdir(), 'maw', 'maw-ready.json');
    }

    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Invalid readiness file type');
    if (uid !== null && info.uid !== uid) throw new Error('Unsafe readiness file owner');
    if (info.mode & 0o077) throw new Error('Unsafe readiness file permissions');

    const raw = await readFile(file, 'utf8');
    const state = JSON.parse(raw);
    if (!Number.isInteger(state.pid) || state.pid <= 0) throw new Error('Invalid readiness PID');

    try {
      process.kill(state.pid, 0);
    } catch {
      throw new Error('Service PID not running');
    }

    const parsedUrl = serviceUrl(state.url);
    const probe = await fetch(parsedUrl, { signal: AbortSignal.timeout(1500), redirect: 'error' });
    if (!probe.ok && probe.status !== 401) throw new Error(`Service probe returned ${probe.status}`);

    return { url: parsedUrl, pid: state.pid, state };
  }

  let performanceSubscribed = false;
  ipcMain.handle(CHANNEL, async (event, command) => {
    if (!trustedSender(event, win.webContents, local.origin) || !validCommand(command)) throw new Error('Invalid desktop request');
    if (command.type === 'restore-shell-storage') {
      const storage = pendingShellStorage;
      pendingShellStorage = null;
      const browserTabs = [
        ...[...views].map(([id, view]) => ({ id, provider: providers.get(id), url: !view.webContents.isDestroyed() ? view.webContents.getURL() : '' })),
        ...suspendedTabs.values(),
      ].filter(tab => durablePage(tab.provider, tab.url)).map(({ id, provider, url }) => ({ id, provider, url }));
      return { ...storage, browserTabs };
    }
    if (command.type === 'get-backend-endpoint') {
      try {
        const found = await discoverBackendReadiness();
        return {
          ok: true,
          url: found.url.href,
          origin: found.url.origin,
          token: found.url.searchParams.get('token'),
          port: found.url.port,
        };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }
    if (command.type === 'performance-subscribe') {
      const snapshot = await (performanceSubscribed ? resourceCollector.refresh() : (performanceSubscribed = true, resourceCollector.subscribe()));
      return { ok: true, snapshot };
    }
    if (command.type === 'performance-unsubscribe') {
      if (performanceSubscribed) resourceCollector.unsubscribe();
      performanceSubscribed = false;
      return { ok: true };
    }
    if (command.type === 'performance-pause') {
      resourceCollector.pause();
      return { ok: true };
    }
    if (command.type === 'performance-resume') {
      resourceCollector.resume();
      return { ok: true };
    }
    if (command.type === 'performance-refresh') {
      const snapshot = await resourceCollector.refresh();
      return { ok: true, snapshot };
    }
    if (command.type === 'open') open(command.id, command.url, command.provider ?? 'chatgpt', true);
    if (command.type === 'update') {
      if (views.has(command.id)) {
        open(command.id, command.url, command.provider ?? providers.get(command.id) ?? 'chatgpt', false);
      } else if (suspendedTabs.has(command.id)) {
        const item = suspendedTabs.get(command.id);
        if (item) {
          if (command.provider && command.provider !== item.provider) throw new Error('This tab cannot change browser provider.');
          if (item.url !== command.url && item.history?.entries?.length) {
            const entries = [...item.history.entries.slice(0, item.history.index + 1), { url: command.url, title: '' }];
            item.history = { entries, index: entries.length - 1 };
          }
          item.url = command.url;
          item.requestedUrl = command.url;
          if (command.provider) item.provider = command.provider;
        }
      }
    }
    if (command.type === 'browser-action') {
      const view = views.get(command.id);
      const contents = view?.webContents;
      if (!contents || contents.isDestroyed()) return;
      lastAccessedAt.set(command.id, Date.now());
      if (command.action === 'back' && contents.canGoBack()) contents.goBack();
      if (command.action === 'forward' && contents.canGoForward()) contents.goForward();
      if (command.action === 'reload') {
        failures.delete(command.id);
        contents.reload();
      }
      if (command.action === 'copy-url') clipboard.writeText(contents.getURL());
      if (command.action === 'copy-selection') contents.copy();
      if (command.action === 'open-page') void openExternal(contents.getURL());
      if (command.action === 'open-link') {
        if (isOAuthLoopbackCallback(command.url)) {
          void shell.openExternal(command.url).catch(() => {});
          return;
        }
        if (authenticationUrl(command.url)) {
          try {
            const current = contents.getURL();
            if (current && current !== 'about:blank' && !authenticationUrl(current)) authEntryUrls.set(contents, current);
          } catch { /* the current document is already gone */ }
          void contents.loadURL(command.url).catch(() => {});
          return;
        }
        const target = targetWebProvider(command.url);
        if (target) {
          send({ type: 'open-web-tab', sourceTabId: command.id, url: command.url });
        } else if (externalUrl(command.url)) {
          void openExternal(command.url);
        }
      }
      if (command.action === 'zoom-in' || command.action === 'zoom-out' || command.action === 'zoom-reset') {
        applyBrowserZoom(command.id, contents, command.action);
      }
    }
    if (command.type === 'copy-file') {
      const resolved = await resolveClipboardTarget(command.cwd, command.relative, { requireAuthoritative: true });
      if (!resolved.ok) return { ok: false, error: resolved.error };
      try {
        const payload = fileClipboardPayload(resolved.absolute);
        if (typeof ClipboardItem !== 'undefined' && typeof clipboard.write === 'function') {
          const item = new ClipboardItem({
            'text/uri-list': new Blob([payload.uriList], { type: 'text/uri-list' }),
            'x-special/gnome-copied-files': new Blob([payload.gnome], { type: 'x-special/gnome-copied-files' }),
          });
          await clipboard.write([item]);
        } else if (typeof clipboard.writeBuffer === 'function') {
          clipboard.writeBuffer('text/uri-list', payload.uriList);
          clipboard.writeBuffer('x-special/gnome-copied-files', payload.gnome);
        }
        return { ok: true, directory: resolved.directory };
      } catch (err) {
        console.error('[desktop] copy-file error:', err);
        return { ok: false, error: 'unavailable' };
      }
    }
    if (command.type === 'write-clipboard-text') {
      try {
        await clipboard.writeText(command.text);
        return { ok: true };
      } catch (err) {
        console.error('[desktop] write-clipboard-text error:', err);
        return { ok: false, error: 'unavailable' };
      }
    }
    if (command.type === 'read-clipboard-text') {
      try {
        const text = await clipboard.readText();
        return { ok: true, text: typeof text === 'string' ? text : '' };
      } catch (err) {
        console.error('[desktop] read-clipboard-text error:', err);
        return { ok: false, error: 'unavailable' };
      }
    }
    if (command.type === 'close') closeView(command.id);
    if (command.type === 'retain') {
      for (const id of views.keys()) if (!command.ids.includes(id)) closeView(id);
      for (const id of [...suspendedTabs.keys()]) if (!command.ids.includes(id)) closeView(id);
    }

    // FEATURE 4: In-memory visual capture fallback for overlapping overlays
    if (command.type === 'capture' && views.has(command.id)) {
      const view = views.get(command.id);
      if (view && !view.webContents.isDestroyed()) {
        try {
          const image = await view.webContents.capturePage();
          return { ok: true, dataUrl: image.toDataURL() };
        } catch {
          return { ok: false };
        }
      }
      return { ok: false };
    }

    // FEATURE 3: Centralized Multi-WebContentsView layout coordinator (atomic reconciliation)
    if (command.type === 'layout') {
      const focusedId = 'focusedId' in command ? command.focusedId : command.id ?? null;
      if (focusedId) lastAccessedAt.set(focusedId, Date.now());
      const focusChanged = focusedId !== layoutFocusedId;
      layoutFocusedId = focusedId;
      if (focusChanged) reportedFocusedId = focusedId;
      const targetViews = Array.isArray(command.views)
        ? command.views
        : (command.id && command.bounds ? [{ id: command.id, bounds: command.bounds }] : []);

      for (const item of targetViews) {
        lastAccessedAt.set(item.id, Date.now());
      }

      if (win.isMinimized() || targetViews.length === 0) {
        hideAll();
        return;
      }

      const contentSize = win.getContentSize();
      const zoom = win.webContents.getZoomFactor();
      const targetIds = new Set(targetViews.map(v => v.id));

      // 1. Detach views no longer visible
      for (const [attachedId, attachedView] of [...attachedViews.entries()]) {
        if (!targetIds.has(attachedId)) {
          win.contentView.removeChildView(attachedView);
          attachedView.setVisible(false);
          attachedViews.delete(attachedId);
        }
      }

      // 2. Attach and update bounds for visible views
      for (const item of targetViews) {
        const view = views.get(item.id);
        if (!view || view.webContents.isDestroyed()) continue;

        const bounds = nativeBoundsForRect(item.bounds, command.viewport, contentSize, zoom);
        if (!bounds) continue;

        if (!attachedViews.has(item.id)) {
          win.contentView.addChildView(view);
          attachedViews.set(item.id, view);
        }

        view.setBounds(bounds);
        view.setVisible(true);
      }

      // Geometry updates and overlay restoration must preserve focus in MAW controls.
      if (focusChanged && focusedId && attachedViews.has(focusedId)) {
        const focusedView = attachedViews.get(focusedId);
        if (focusedView && !focusedView.webContents.isDestroyed() && !focusedView.webContents.isFocused()) {
          focusedView.webContents.focus();
        }
      }
    }
  });

  if (isWebAuthnEnabled) {
    ipcMain.handle('maw:webauthn:is-available', async () => {
      return { available: await isFido2ToolsAvailable() };
    });

    ipcMain.handle('maw:webauthn:get', async (event, options) => {
      const senderWebContents = event.sender;
      if (!senderWebContents || senderWebContents.isDestroyed() || senderWebContents.session !== chatSession) {
        return { success: false, error: { name: 'SecurityError', message: 'WebAuthn is only permitted within the ChatGPT session' } };
      }

      let origin = '';
      try {
        origin = event.senderFrame?.origin || new URL(senderWebContents.getURL()).origin;
      } catch {
        return { success: false, error: { name: 'SecurityError', message: 'Could not determine frame origin' } };
      }

      const extraOrigins = (process.env.MAW_WEBAUTHN_EXTRA_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
      if (!isAllowedWebAuthnOrigin(origin, extraOrigins)) {
        return { success: false, error: { name: 'SecurityError', message: `Origin ${origin} is not authorized for WebAuthn` } };
      }

      const rpId = options?.rpId;
      if (!isValidRpId(rpId, origin)) {
        return { success: false, error: { name: 'SecurityError', message: `Requested rpId ${rpId} does not match origin ${origin}` } };
      }

      const devices = await discoverFido2Devices();
      if (devices.length === 0) {
        return { success: false, error: { name: 'NotAllowedError', message: 'No FIDO2 hardware device found. Please insert your security key.' } };
      }
      const device = devices[0];

      const caps = await getDeviceCapabilities(device.path);
      let pin = null;
      const userVerification = options?.userVerification || 'preferred';
      const pinRequired = caps.hasClientPin && (userVerification === 'required' || userVerification === 'preferred');

      if (pinRequired) {
        const parentWin = BrowserWindow.fromWebContents(senderWebContents) || win;
        let paneBounds = null;
        for (const [id, view] of attachedViews.entries()) {
          if (view.webContents === senderWebContents) {
            try {
              paneBounds = view.getBounds();
            } catch {}
            break;
          }
        }
        if (!paneBounds && popupOwners.has(senderWebContents)) {
          const ownerId = popupOwners.get(senderWebContents);
          const ownerView = attachedViews.get(ownerId);
          if (ownerView) {
            try {
              paneBounds = ownerView.getBounds();
            } catch {}
          }
        }
        try {
          pin = await requestPinDialog({
            parentWindow: parentWin,
            paneBounds,
            rpId,
            title: 'Security Key PIN',
          });
        } catch (err) {
          return { success: false, error: classifyWebAuthnError(err) };
        }
      }

      const challengeBase64Url = options?.challenge || '';
      const { clientDataJSONBuffer, clientDataHash } = generateClientData('webauthn.get', challengeBase64Url, origin);

      const allowCredentials = Array.isArray(options?.allowCredentials) ? options.allowCredentials : [];
      const isResident = allowCredentials.length === 0;
      const credId = !isResident ? allowCredentials[0]?.id : '';

      try {
        const stdout = await executeAssertion({
          devicePath: device.path,
          rpId,
          clientDataHash,
          credentialId: credId,
          isResident,
          pin,
          timeoutMs: (options?.timeout ? options.timeout * 1000 : 60000),
        });

        const parsed = parseFido2AssertOutput(stdout, {
          rpId,
          credentialId: credId,
          clientDataJSONBuffer,
        });

        return { success: true, data: parsed };
      } catch (err) {
        return { success: false, error: classifyWebAuthnError(err) };
      } finally {
        pin = null;
      }
    });
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isOAuthLoopbackCallback(url)) {
      void shell.openExternal(url).catch(() => {});
      return { action: 'deny' };
    }
    void openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (isOAuthLoopbackCallback(url)) {
      event.preventDefault();
      void shell.openExternal(url).catch(() => {});
      return;
    }
    try { if (new URL(url).origin === local.origin && new URL(url).pathname === '/') return; } catch {}
    event.preventDefault();
  });
  win.webContents.on('will-redirect', (event, url) => {
    if (isOAuthLoopbackCallback(url)) {
      event.preventDefault();
      void shell.openExternal(url).catch(() => {});
      return;
    }
    if (new URL(url).origin !== local.origin) event.preventDefault();
  });
  win.webContents.on('did-start-loading', () => {
    hideAll();
    if (performanceSubscribed) resourceCollector.unsubscribe();
    performanceSubscribed = false;
  });
  win.webContents.on('render-process-gone', hideAll);
  for (const event of ['minimize', 'restore', 'enter-full-screen', 'leave-full-screen']) win.on(event, invalidate);
  win.on('resize', () => send({ type: 'layout-needed' }));
  win.webContents.on('before-input-event', desktopShortcut);

  let backendFailureCount = 0;
  const checkInterval = setInterval(async () => {
    if (shuttingDown) return;
    trimCapacity();
    try {
      const probe = await fetch(local, { signal: AbortSignal.timeout(1200), redirect: 'error' });
      if (probe.ok || probe.status === 401) {
        backendFailureCount = 0;
        return;
      }
      backendFailureCount++;
    } catch {
      backendFailureCount++;
    }

    if (backendFailureCount > 0) {
      try {
        const discovered = await discoverBackendReadiness();
        if (discovered.url.href !== local.href) {
          const originChanged = discovered.url.origin !== local.origin;
          if (originChanged) {
            // Only MAW's own renderer storage crosses a loopback-port change.
            // Website sessions and live views stay in their existing partitions.
            pendingShellStorage = await win.webContents.executeJavaScript('({ local: Object.entries(localStorage), session: Object.entries(sessionStorage) })');
          }
          local = discovered.url;
          backendFailureCount = 0;
          if (originChanged) {
            hideAll();
            await win.loadURL(local.href);
            return;
          }
          send({
            type: 'backend-reconnected',
            url: discovered.url.href,
            token: discovered.url.searchParams.get('token'),
            port: discovered.url.port,
          });
        }
      } catch {}
    }
  }, 2000);
  checkInterval.unref();

  app.on('second-instance', (_event, _argv, _cwd, data) => {
    try {
      const next = serviceUrl(data.serviceUrl);
      if (next.href !== local.href) { hideAll(); local = next; void win.loadURL(local.href).catch(() => {}); }
    } catch { return; }
    if (win.isMinimized()) win.restore(); win.show(); win.focus();
  });
  win.on('close', event => {
    if (shuttingDown) return;
    event.preventDefault();
    shuttingDown = true;
    clearInterval(checkInterval);
    resourceCollector.dispose();
    hideAll();
    for (const popup of popups) {
      try {
        if (!popup.isDestroyed()) popup.destroy();
      } catch {}
    }
    popups.clear();
    popupOwners.clear();
    for (const view of views.values()) if (!view.webContents.isDestroyed()) view.webContents.close();
    views.clear();
    suspendedTabs.clear();
    lastAccessedAt.clear();
    interactionProtected.clear();
    zoomLevels.clear();
    activeDownloads.clear();
    chatSession.flushStorageData();
    githubSession.flushStorageData();
    perplexitySession.flushStorageData();
    browserSession.flushStorageData();
    void Promise.allSettled([
      chatSession.cookies.flushStore(),
      githubSession.cookies.flushStore(),
      perplexitySession.cookies.flushStore(),
      browserSession.cookies.flushStore(),
    ]).finally(() => win.close());
  });
  app.on('window-all-closed', () => app.quit());
  await win.loadURL(local.href);
}
void start().catch(() => { console.error('MAW desktop could not start. Check service readiness and the desktop runtime installation.'); app.exit(1); });
