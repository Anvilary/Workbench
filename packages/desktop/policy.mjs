import { isIP } from 'node:net';

export const PARTITION = 'persist:maw-chatgpt';
export const CHANNEL = 'maw:chatgpt';
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const authHosts = new Set(['auth.openai.com', 'auth0.openai.com', 'accounts.google.com', 'appleid.apple.com', 'login.microsoftonline.com', 'login.live.com']);
const fileDeliveryHosts = new Set(['files.oaiusercontent.com', 'oaistatic.com']);

function httpsUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port ? url : null;
  } catch { return null; }
}

export function chatUrl(value) { return ['chatgpt.com', 'chat.openai.com'].includes(httpsUrl(value)?.hostname); }

export function isFileDeliveryHost(hostname) {
  if (!hostname || typeof hostname !== 'string') return false;
  return fileDeliveryHosts.has(hostname) || hostname.endsWith('.oaiusercontent.com') || hostname.endsWith('.oaistatic.com');
}

export function isDownloadOrFileDeliveryUrl(value) {
  if (typeof value !== 'string') return false;
  if (value.startsWith('blob:https://chatgpt.com/') || value.startsWith('blob:https://chat.openai.com/')) return true;
  const url = httpsUrl(value);
  return !!url && isFileDeliveryHost(url.hostname);
}

export function embeddedUrl(value) {
  const url = httpsUrl(value);
  return !!url && (chatUrl(value) || authHosts.has(url.hostname));
}

export function externalUrl(value) {
  const url = httpsUrl(value);
  if (!url) return false;
  const host = url.hostname;
  return !isIP(host.replace(/^\[|\]$/g, '')) && host.includes('.') &&
    !['localhost', 'local', 'internal', 'test', 'invalid', 'example'].some(suffix => host === suffix || host.endsWith('.' + suffix));
}

export function serviceUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' || url.username || url.password || url.hash) throw new Error('MAW_DESKTOP_URL must be the local MAW http://127.0.0.1:PORT/ URL');
  return url;
}

export function trustedSender(event, contents, origin) {
  try { return event.sender === contents && event.senderFrame === contents.mainFrame && new URL(event.senderFrame.url).origin === origin && new URL(event.senderFrame.url).pathname === '/'; }
  catch { return false; }
}

const record = value => value && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => record(value) && Object.keys(value).sort().join() === keys.sort().join();

function boundsOverlap(r1, r2) {
  return !(r1.x + r1.width <= r2.x || r2.x + r2.width <= r1.x || r1.y + r1.height <= r2.y || r2.y + r2.height <= r1.y);
}

export function validCommand(value) {
  if (!record(value)) return false;
  if (value.type === 'retain') return exact(value, ['type', 'ids']) && Array.isArray(value.ids) && value.ids.length <= 4096 && value.ids.every(id => typeof id === 'string' && UUID.test(id));
  if (value.type === 'open' || value.type === 'update') return exact(value, ['type', 'id', 'url']) && typeof value.id === 'string' && UUID.test(value.id) && chatUrl(value.url);
  if (value.type === 'close' || value.type === 'capture') return exact(value, ['type', 'id']) && typeof value.id === 'string' && UUID.test(value.id);

  if (value.type === 'layout') {
    // Single-view layout (legacy / simple)
    if (exact(value, ['type', 'id', 'bounds', 'viewport'])) {
      if (value.id !== null && (typeof value.id !== 'string' || !UUID.test(value.id))) return false;
      if (!exact(value.bounds, ['x', 'y', 'width', 'height']) || !exact(value.viewport, ['width', 'height'])) return false;
      return [...Object.values(value.bounds), ...Object.values(value.viewport)].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 32768);
    }

    // Multi-view layout (Feature 3)
    const hasFocus = 'focusedId' in value;
    const expectedKeys = hasFocus ? ['type', 'views', 'viewport', 'focusedId'] : ['type', 'views', 'viewport'];
    if (!exact(value, expectedKeys)) return false;
    if (!Array.isArray(value.views) || value.views.length > 4) return false;
    if (!exact(value.viewport, ['width', 'height'])) return false;
    if (![value.viewport.width, value.viewport.height].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 32768)) return false;
    if (hasFocus && value.focusedId !== null && (typeof value.focusedId !== 'string' || !UUID.test(value.focusedId))) return false;

    const seenIds = new Set();
    const v = value.viewport;
    for (let i = 0; i < value.views.length; i++) {
      const item = value.views[i];
      if (!record(item) || !exact(item, ['id', 'bounds'])) return false;
      if (typeof item.id !== 'string' || !UUID.test(item.id) || seenIds.has(item.id)) return false;
      seenIds.add(item.id);
      const b = item.bounds;
      if (!record(b) || !exact(b, ['x', 'y', 'width', 'height'])) return false;
      if (![b.x, b.y, b.width, b.height].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 32768)) return false;
      if (b.x + b.width > v.width || b.y + b.height > v.height) return false;

      // Check non-overlapping content rectangles
      for (let j = 0; j < i; j++) {
        if (boundsOverlap(b, value.views[j].bounds)) return false;
      }
    }
    return true;
  }

  return false;
}

export function nativeBoundsForRect(b, v, contentSize, zoom) {
  if (!b || !v || b.width < 1 || b.height < 1 || b.x + b.width > v.width || b.y + b.height > v.height) return null;
  if (Math.abs(v.width * zoom - contentSize[0]) > 2 || Math.abs(v.height * zoom - contentSize[1]) > 2) return null;
  const x = Math.ceil(b.x * zoom), y = Math.ceil(b.y * zoom);
  return { x, y, width: Math.max(0, Math.floor((b.x + b.width) * zoom) - x), height: Math.max(0, Math.floor((b.y + b.height) * zoom) - y) };
}

export function nativeBounds(command, contentSize, zoom) {
  if (!command.id || !command.bounds || !command.viewport) return null;
  return nativeBoundsForRect(command.bounds, command.viewport, contentSize, zoom);
}
