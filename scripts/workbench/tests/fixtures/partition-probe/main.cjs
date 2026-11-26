// Electron probe for the identity migration partition test.
//
// `write` mode fills every requested session partition with persistent browser state (cookie with an
// expiry, localStorage, an IndexedDB record, a service worker that caches a response, and a custom
// spellchecker word). `read` mode reads the same state back. Both modes serve the page from
// 127.0.0.1 on the SAME port: localStorage, IndexedDB and service workers are origin-keyed including
// the port, so the read phase must reuse the port the write phase reports.
//
// Environment:
//   WB_PROBE_MODE=write|read   WB_PROBE_PARTITIONS=persist:a,persist:b
//   WB_PROBE_USER_DATA=<dir>   WB_PROBE_OUT=<json file>   WB_PROBE_PORT=<port or 0>
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');

// Keep the app alive while the probe closes and reopens windows in the same partition.
app.on('window-all-closed', () => {});

const mode = process.env.WB_PROBE_MODE;
const partitions = String(process.env.WB_PROBE_PARTITIONS || '').split(',').filter((name) => name !== '');
const outFile = process.env.WB_PROBE_OUT;
const userData = process.env.WB_PROBE_USER_DATA;
const origin = process.env.WB_PROBE_ORIGIN;
const port = Number(process.env.WB_PROBE_PORT || 0);
const PROBE_WORD = 'anvilaryworkbench';

if (!['write', 'read'].includes(mode) || partitions.length === 0 || !outFile || !userData) {
  console.error('partition-probe: WB_PROBE_MODE, WB_PROBE_PARTITIONS, WB_PROBE_USER_DATA and WB_PROBE_OUT are required');
  process.exit(64);
}

fs.mkdirSync(userData, { recursive: true });
app.setPath('userData', userData);
app.commandLine.appendSwitch('disable-features', 'DialMediaRouteProvider');

const WRITE_SCRIPT = (tag) => `(async () => {
  const authenticated = await fetch('/auth').then((response) => response.text());
  localStorage.setItem('wb-probe', 'ls-${tag}');
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('wb-probe', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('kv');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise((resolve, reject) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put('idb-${tag}', 'probe-key');
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
  await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  await navigator.serviceWorker.ready;
  const cached = await caches.match('/cached.txt');
  return { localStorage: localStorage.getItem('wb-probe'), cache: cached ? await cached.text() : null, authenticated, httpOnlyCookieHidden: !document.cookie.includes('wb_probe=') };
})()`;

const READ_SCRIPT = `(async () => {
  const authenticated = await fetch('/auth').then((response) => response.text());
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('wb-probe', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('kv');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const indexedDbValue = await new Promise((resolve, reject) => {
    const tx = db.transaction('kv', 'readonly');
    const get = tx.objectStore('kv').get('probe-key');
    get.onsuccess = () => resolve(get.result ?? null);
    get.onerror = () => reject(get.error);
  });
  db.close();
  const registrations = await navigator.serviceWorker.getRegistrations();
  const cached = await caches.match('/cached.txt');
  return {
    localStorage: localStorage.getItem('wb-probe'),
    indexedDb: indexedDbValue,
    serviceWorkers: registrations.length,
    cache: cached ? await cached.text() : null,
    authenticated,
    httpOnlyCookieHidden: !document.cookie.includes('wb_probe='),
  };
})()`;

const READ_IDB_AFTER_WRITE = `(async () => {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('wb-probe', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('kv');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const value = await new Promise((resolve, reject) => {
    const tx = db.transaction('kv', 'readonly');
    const get = tx.objectStore('kv').get('probe-key');
    get.onsuccess = () => resolve(get.result ?? null);
    get.onerror = () => reject(get.error);
  });
  db.close();
  const registrations = await navigator.serviceWorker.getRegistrations();
  return { indexedDb: value, serviceWorkers: registrations.length };
})()`;

async function withWindow(partition, origin, run) {
  const window = new BrowserWindow({
    show: false,
    width: 420,
    height: 320,
    webPreferences: { partition, contextIsolation: true, nodeIntegration: false, spellcheck: true },
  });
  try {
    await window.loadURL(origin);
    return await run(window);
  } finally {
    window.destroy();
  }
}

async function main() {
  if (!origin || port < 1) throw new Error('WB_PROBE_ORIGIN and WB_PROBE_PORT must point to the parent test server');
  const result = { mode, port, partitions: {} };

  for (const partition of partitions) {
    const ses = session.fromPartition(partition);
    const tag = partition.replace('persist:', '').replace(/^(maw|workbench)-/, '');
    await ses.setSpellCheckerLanguages(['en-US']);
    await ses.listWordsInSpellCheckerDictionary();
    if (mode === 'write') {
      await ses.cookies.set({
        url: origin,
        name: 'wb_probe',
        value: `cookie-${tag}`,
        expirationDate: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30,
        httpOnly: true,
      });
      ses.addWordToSpellCheckerDictionary(PROBE_WORD);
      const written = await withWindow(partition, origin, (window) => window.webContents.executeJavaScript(WRITE_SCRIPT(tag), true));
      // Re-open to confirm the state is readable before the quit, so a read-phase failure is unambiguous.
      const reread = await withWindow(partition, origin, (window) => window.webContents.executeJavaScript(READ_IDB_AFTER_WRITE, true));
      const dictionary = await ses.listWordsInSpellCheckerDictionary();
      const cookies = await ses.cookies.get({ name: 'wb_probe' });
      result.partitions[tag] = {
        cookie: cookies.map((cookie) => ({ value: cookie.value, persistent: typeof cookie.expirationDate === 'number', httpOnly: cookie.httpOnly })),
        localStorage: written.localStorage,
        cache: written.cache,
        authenticated: written.authenticated,
        httpOnlyCookieHidden: written.httpOnlyCookieHidden,
        indexedDb: reread.indexedDb,
        serviceWorkers: reread.serviceWorkers,
        dictionary,
      };
      await ses.cookies.flushStore();
    } else {
      const read = await withWindow(partition, origin, (window) => window.webContents.executeJavaScript(READ_SCRIPT, true));
      const cookies = await ses.cookies.get({ name: 'wb_probe' });
      result.partitions[tag] = {
        cookie: cookies.map((cookie) => ({ value: cookie.value, persistent: typeof cookie.expirationDate === 'number', httpOnly: cookie.httpOnly })),
        localStorage: read.localStorage,
        cache: read.cache,
        authenticated: read.authenticated,
        httpOnlyCookieHidden: read.httpOnlyCookieHidden,
        indexedDb: read.indexedDb,
        serviceWorkers: read.serviceWorkers,
        dictionary: await ses.listWordsInSpellCheckerDictionary(),
      };
    }
  }
  fs.writeFileSync(outFile, `${JSON.stringify(result, null, 2)}\n`);
}

app.whenReady().then(async () => {
  try {
    await main();
    app.exit(0);
  } catch (error) {
    console.error(`partition-probe failed: ${error && error.stack ? error.stack : error}`);
    app.exit(70);
  }
});
