/**
 * Same-origin access to the genuine Neko v3 client. Mount after MAW's HTTP
 * authentication and before the UI fallback. Neko must use
 * NEKO_SERVER_PATH_PREFIX=/api/agency/browser/viewer (the prefix is retained).
 *
 * Neko credentials/cookies stay in this process. The browser receives only an
 * opaque, HttpOnly proxy-session cookie, bound to its MAW credential. Neither
 * controller/CDP endpoints nor Neko's administrative API are exposed.
 * Protocol: https://github.com/m1k1o/neko/blob/master/server/internal/api/session.go
 */
import { createHash, randomBytes } from 'node:crypto';
import { request as httpRequest, type IncomingMessage, type IncomingHttpHeaders, type Server } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Duplex } from 'node:stream';
import type { Express, Request, Response } from 'express';
import type { DeviceVerifier } from '../remote-access.js';
import { authorizeRequest, authorizeRequestNoAuth } from '../security.js';

export const NEKO_VIEWER_PATH = '/api/agency/browser/viewer';
const VIEWER_COOKIE = 'maw_neko_viewer';
const TIMEOUT_MS = 5_000;
const SESSION_TTL_MS = 30 * 60_000;
const MAX_SESSIONS = 128;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

export interface NekoViewerOptions {
  app: Express;
  httpServer: Server;
  port: number;
  token: string;
  remote: { verifier(): DeviceVerifier | null };
  /** When true, MAW_UNSAFE_LOCAL_NO_AUTH=1 is active; token check is skipped. */
  noAuth?: boolean;
  env?: NodeJS.ProcessEnv;
  validateSelectedTab?: (workspaceId: string, tabId: string) => boolean | Promise<boolean>;
}

interface Selection { workspaceId: string; tabId: string }
interface ViewerSession {
  owner: string;
  cookie: string;
  touchedAt: number;
  selection: Selection | null;
}
interface UpstreamResponse { status: number; headers: IncomingHttpHeaders; body: Buffer }

function configuredUpstream(env: NodeJS.ProcessEnv): URL | null {
  try {
    const url = new URL(env['NEKO_VIEWER_URL'] || 'http://127.0.0.1:8085');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
    // This is a local service, never a general-purpose proxy or CDP/controller bridge.
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return null;
    if (!['', '/', NEKO_VIEWER_PATH, NEKO_VIEWER_PATH + '/'].includes(url.pathname)) return null;
    if (['9222', '9223'].includes(url.port)) return null;
    return new URL(url.origin);
  } catch { return null; }
}

function selectionFrom(url: URL): Selection | null {
  const workspaceId = url.searchParams.get('workspaceId');
  const tabId = url.searchParams.get('tabId');
  if (!workspaceId || !tabId || workspaceId.length > 200 || tabId.length > 200) return null;
  return { workspaceId, tabId };
}

function ownerFor(request: IncomingMessage, options: NekoViewerOptions): string | number {
  try {
    const result = options.noAuth
      ? authorizeRequestNoAuth(request, options.port)
      : authorizeRequest(request, options.port, options.token, options.remote.verifier());
    if (!result.ok) return result.reason === 'bad-token' ? 401 : 403;
    return result.credential.kind === 'device'
      ? `device:${result.credential.deviceId}`
      : result.credential.kind === 'local'
        ? 'local'
        : createHash('sha256').update(options.token).digest('hex');
  } catch { return 401; }
}

function sessionId(request: IncomingMessage): string | undefined {
  const cookie = request.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith(VIEWER_COOKIE + '='));
  const value = cookie?.slice(VIEWER_COOKIE.length + 1);
  return value && /^[a-f0-9]{64}$/.test(value) ? value : undefined;
}

function upstreamRequest(upstream: URL, path: string, cookie?: string, body?: string): Promise<UpstreamResponse> {
  return new Promise((resolve, reject) => {
    const request = (upstream.protocol === 'https:' ? httpsRequest : httpRequest)(new URL(path, upstream), {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        accept: '*/*',
        ...(cookie ? { cookie } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }),
      },
    }, response => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) request.destroy(new Error('Neko response too large'));
        else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode ?? 502, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    const timeout = setTimeout(() => request.destroy(new Error('Neko request timed out')), TIMEOUT_MS);
    request.on('close', () => clearTimeout(timeout));
    request.on('error', reject);
    request.end(body);
  });
}

// This script observes only the upstream Neko media element, never the browser
// page inside the video. A loaded iframe or an available API is not inspection.
const MEDIA_READY_SCRIPT = `<script>
(() => {
  const q = new URLSearchParams(location.search);
  const workspaceId = q.get('workspaceId'), tabId = q.get('tabId');
  if (!workspaceId || !tabId || window.parent === window) return;
  let wasReady = false;
  let stopped = false;
  const stalled = new WeakSet();
  const post = ready => parent.postMessage({
    type: ready ? 'agency.browser.viewer.ready' : 'agency.browser.viewer.unavailable',
    workspaceId, tabId
  }, location.origin);
  const check = () => {
    if (stopped) return;
    const ready = Array.from(document.querySelectorAll('video')).some(video => {
      const stream = video.srcObject;
      return !stalled.has(video) && video.readyState >= 2 && video.videoWidth > 0 && !video.paused && !video.ended &&
        stream && typeof stream.getVideoTracks === 'function' &&
        stream.getVideoTracks().some(track => track.readyState === 'live' && !track.muted);
    });
    if (ready !== wasReady) { wasReady = ready; post(ready); }
  };
  const timer = setInterval(check, 250);
  for (const event of ['playing','loadeddata','canplay','pause','emptied','ended','waiting','stalled'])
    document.addEventListener(event, event => {
      if (event.target instanceof HTMLVideoElement) {
        if (['playing','loadeddata','canplay'].includes(event.type)) stalled.delete(event.target);
        else stalled.add(event.target);
      }
      check();
    }, true);
  window.addEventListener('pagehide', () => { stopped = true; clearInterval(timer); post(false); });
})();
</script>`;

function allowedHttpPath(path: string): boolean {
  if (path === '/' || path === '/index.html') return true;
  // Vite and legacy Vue bundles, fonts, icons and translations. Deliberately
  // exclude the API, legacy /ws, metrics, pprof, file transfer, and arbitrary paths.
  return /^\/(?:assets|js|css|img|fonts|locales)\/[a-zA-Z0-9_./@-]+\.(?:js|mjs|css|png|jpg|jpeg|svg|webp|ico|woff2?|ttf|json|wasm)$/.test(path)
    || /^\/(?:favicon\.(?:ico|png)|logo\.png|manifest\.json|keyboard_layouts\.json|emoji\.json|chat\.mp3|site\.webmanifest|browserconfig\.xml|safari-pinned-tab\.svg|apple-touch-icon\.png|(?:favicon|android-chrome|mstile)-\d+x\d+\.png)$/.test(path)
    || ['/api/whoami', '/api/oauth/config', '/api/stats', '/api/room/screen', '/api/room/screen/', '/api/room/screen/cast.jpg',
      '/api/room/control/', '/api/room/keyboard/map', '/api/room/keyboard/modifiers'].includes(path);
}

/** No network work is done until an authenticated request arrives. */
export function mountNekoViewer(options: NekoViewerOptions): { dispose(): void } {
  const env = options.env ?? process.env;
  const upstream = configuredUpstream(env);
  const password = env['NEKO_PASSWORD'] || env['NEKO_MEMBER_MULTIUSER_USER_PASSWORD'];
  const configured = upstream !== null && typeof password === 'string' && password.length > 0;
  const sessions = new Map<string, ViewerSession>();
  const sockets = new Set<Duplex>();
  let disposed = false;

  async function validSelection(selection: Selection | null): Promise<boolean> {
    if (!options.validateSelectedTab) return true;
    return selection !== null && await options.validateSelectedTab(selection.workspaceId, selection.tabId);
  }

  async function login(owner: string, selection: Selection | null): Promise<{ id: string; session: ViewerSession }> {
    if (!upstream || !password || disposed) throw new Error('Viewer unavailable');
    for (const [id, session] of sessions) if (Date.now() - session.touchedAt > SESSION_TTL_MS) sessions.delete(id);
    if (sessions.size >= MAX_SESSIONS) throw new Error('Viewer session capacity reached');
    const response = await upstreamRequest(upstream, NEKO_VIEWER_PATH + '/api/login', undefined,
      JSON.stringify({ username: 'MAW viewer', password }));
    if (response.status !== 200) throw new Error('Neko login failed');
    const payload = JSON.parse(response.body.toString('utf8')) as { profile?: Record<string, unknown> };
    const profile = payload.profile;
    if (profile?.['is_admin'] !== false || profile['can_login'] !== true || profile['can_watch'] !== true
      || profile['can_connect'] !== true || profile['can_host'] !== true
      || profile['can_share_media'] !== false || profile['can_access_clipboard'] !== false) {
      throw new Error('Neko requires a non-admin interactive profile without clipboard or media sharing');
    }
    const cookies = response.headers['set-cookie']?.map(value => value.split(';', 1)[0]).filter(Boolean);
    if (!cookies?.length) throw new Error('Neko cookie sessions must be enabled');
    const id = randomBytes(32).toString('hex');
    const session: ViewerSession = { owner, cookie: cookies.join('; '), touchedAt: Date.now(), selection };
    sessions.set(id, session);
    return { id, session };
  }

  function findSession(request: IncomingMessage, owner: string): ViewerSession | undefined {
    const id = sessionId(request);
    const session = id ? sessions.get(id) : undefined;
    if (!session || session.owner !== owner || Date.now() - session.touchedAt > SESSION_TTL_MS) return undefined;
    session.touchedAt = Date.now();
    return session;
  }

  async function handle(request: Request, response: Response): Promise<void> {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    const owner = ownerFor(request, options);
    if (typeof owner === 'number') { response.status(owner).json({ error: 'Viewer authorization required' }); return; }
    const url = new URL(request.originalUrl, 'http://localhost');
    const path = url.pathname.slice(NEKO_VIEWER_PATH.length);
    const controlAction = request.method === 'POST' && ['/api/room/control/request', '/api/room/control/release'].includes(path);
    if (request.method !== 'GET' && request.method !== 'HEAD' && !controlAction) {
      response.status(405).json({ error: 'Viewer method not allowed' }); return;
    }

    if (path === '/status') {
      let ready = false;
      if (configured && upstream && !disposed) {
        try { ready = (await upstreamRequest(upstream, NEKO_VIEWER_PATH + '/')).status === 200; } catch { /* unavailable */ }
      }
      response.json({ configured, ready, url: NEKO_VIEWER_PATH + '/', ...(!ready ? { reason: configured ? 'unavailable' : 'not-configured' } : {}) });
      return;
    }
    if (!configured || !upstream || disposed) { response.status(503).json({ error: 'Neko viewer is not configured or unavailable' }); return; }

    if (path === '') {
      const selection = selectionFrom(url);
      if (!selection) { response.status(400).json({ error: 'workspaceId and tabId are required' }); return; }
      if (!await validSelection(selection)) { response.status(409).json({ error: 'Browser tab is not selected' }); return; }
      const query = new URLSearchParams({ ...selection });
      response.json({ url: NEKO_VIEWER_PATH + '/?' + query.toString(), ...selection });
      return;
    }
    // Reject encoded separators, traversal, and query credentials before proxying.
    if (/%|\\|(?:^|\/)\.\.?(?:\/|$)/.test(path) || (!allowedHttpPath(path) && !controlAction)) {
      response.status(404).json({ error: 'Viewer resource not found' }); return;
    }
    const entry = path === '/' || path === '/index.html';
    let session = findSession(request, owner);
    if (entry) {
      const selection = selectionFrom(url);
      if (!await validSelection(selection)) { response.status(409).json({ error: 'Browser tab is not selected' }); return; }
      if ([...url.searchParams.keys()].some(key => key !== 'workspaceId' && key !== 'tabId')) {
        // Neko's client interprets ?token=/pwd= itself. Never let credentials
        // from a bookmarked MAW URL become client-side Neko login state.
        const query = selection ? '?' + new URLSearchParams({ ...selection }).toString() : '';
        response.redirect(303, NEKO_VIEWER_PATH + '/' + query);
        return;
      }
      if (!session) {
        const created = await login(owner, selection);
        session = created.session;
        response.appendHeader('Set-Cookie', `${VIEWER_COOKIE}=${created.id}; Path=${NEKO_VIEWER_PATH}/; HttpOnly; SameSite=Strict`);
      } else session.selection = selection;
    }
    if (!session) { response.status(401).json({ error: 'Open the viewer first' }); return; }
    if (path.startsWith('/api/') && !await validSelection(session.selection)) {
      response.status(409).json({ error: 'Browser tab is not selected' }); return;
    }
    // No client query strings, Cookie, Authorization, forwarding headers or MAW
    // credentials reach Neko. Static bundle cache-busting queries are unnecessary.
    const result = await upstreamRequest(upstream, NEKO_VIEWER_PATH + path, session.cookie, controlAction ? '{}' : undefined);
    if (result.status < 200 || result.status >= 300) {
      if (result.status === 401) { const id = sessionId(request); if (id) sessions.delete(id); }
      response.status(result.status >= 400 && result.status < 500 ? result.status : 502).json({ error: 'Neko viewer resource unavailable' });
      return;
    }
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'SAMEORIGIN');
    let body = result.body;
    if (path === '/api/whoami') {
      const payload = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
      // No Neko bearer token or provider extra_data ever reaches client code.
      body = Buffer.from(JSON.stringify({ id: payload['id'], profile: payload['profile'], state: payload['state'] }));
    }
    const contentType = result.headers['content-type'] ?? 'application/octet-stream';
    if (entry) {
      if (!contentType.includes('text/html')) throw new Error('Neko did not serve its client');
      const html = body.toString('utf8');
      body = Buffer.from(html.includes('</head>') ? html.replace('</head>', MEDIA_READY_SCRIPT + '</head>') : MEDIA_READY_SCRIPT + html);
    }
    response.status(result.status).type(contentType).send(body);
  }

  options.app.use(NEKO_VIEWER_PATH, (request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) response.status(502).json({ error: 'Neko viewer unavailable' });
      else response.destroy();
    });
  });

  function rejectSocket(socket: Duplex, status: number): void {
    socket.end(`HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : 'Unavailable'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  }

  async function upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const owner = ownerFor(request, options);
    if (typeof owner === 'number') { rejectSocket(socket, owner); return; }
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname !== NEKO_VIEWER_PATH + '/api/ws' || request.method !== 'GET') { rejectSocket(socket, 404); return; }
    const session = findSession(request, owner);
    if (!session) { rejectSocket(socket, 401); return; }
    if (!upstream || !configured || disposed) { rejectSocket(socket, 503); return; }
    const selection = session.selection;
    if (!await validSelection(selection)) { rejectSocket(socket, 409); return; }
    const outgoing = (upstream.protocol === 'https:' ? httpsRequest : httpRequest)(new URL(NEKO_VIEWER_PATH + '/api/ws', upstream), {
      headers: {
        connection: 'Upgrade', upgrade: 'websocket', cookie: session.cookie,
        origin: upstream.origin,
        'sec-websocket-key': request.headers['sec-websocket-key'] ?? '',
        'sec-websocket-version': '13',
        ...(request.headers['sec-websocket-protocol'] ? { 'sec-websocket-protocol': request.headers['sec-websocket-protocol'] } : {}),
        ...(request.headers['sec-websocket-extensions'] ? { 'sec-websocket-extensions': request.headers['sec-websocket-extensions'] } : {}),
      },
    });
    const timeout = setTimeout(() => outgoing.destroy(new Error('Neko upgrade timed out')), TIMEOUT_MS);
    outgoing.on('close', () => clearTimeout(timeout));
    outgoing.on('error', () => rejectSocket(socket, 502));
    outgoing.on('response', response => { response.resume(); rejectSocket(socket, 502); });
    socket.once('close', () => outgoing.destroy());
    outgoing.on('upgrade', (response, peer, peerHead) => {
      clearTimeout(timeout);
      if (socket.destroyed || disposed) { peer.destroy(); return; }
      const headers = ['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade'];
      for (const name of ['sec-websocket-accept', 'sec-websocket-protocol', 'sec-websocket-extensions']) {
        const value = response.headers[name];
        if (typeof value === 'string') headers.push(`${name}: ${value}`);
      }
      socket.write(headers.join('\r\n') + '\r\n\r\n');
      if (head.length) peer.write(head);
      if (peerHead.length) socket.write(peerHead);
      sockets.add(socket); sockets.add(peer);
      let checking = false;
      const guard = setInterval(() => {
        if (checking) return;
        checking = true;
        void Promise.resolve().then(async () => {
          if (ownerFor(request, options) !== owner || !await validSelection(selection)) close();
        }).catch(close).finally(() => { checking = false; });
      }, 1_000);
      guard.unref();
      const close = (): void => {
        clearInterval(guard);
        sockets.delete(socket); sockets.delete(peer); socket.destroy(); peer.destroy();
      };
      peer.on('data', () => { session.touchedAt = Date.now(); });
      socket.on('error', close); peer.on('error', close);
      socket.on('close', close); peer.on('close', close);
      socket.pipe(peer); peer.pipe(socket);
    });
    outgoing.end();
  }

  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    // Leave the terminal socket and Vite's HMR socket to their own handlers.
    const pathname = (request.url ?? '').split('?', 1)[0] ?? '';
    if (pathname !== NEKO_VIEWER_PATH && !pathname.startsWith(NEKO_VIEWER_PATH + '/')) return;
    void upgrade(request, socket, head).catch(() => rejectSocket(socket, 502));
  };
  options.httpServer.on('upgrade', onUpgrade);

  return { dispose() {
    disposed = true;
    options.httpServer.off('upgrade', onUpgrade);
    for (const socket of sockets) socket.destroy();
    sockets.clear(); sessions.clear();
  } };
}
