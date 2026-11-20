import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  DEFAULT_BROWSER_PROFILE_ID,
  isValidBrowserProfileId,
  partitionForBrowserProfile,
  validCommand,
} from '../../../policy.mjs';
import {
  toCookieSetDetails,
  cloneBrowserProfileStorage,
  clearProfileSiteAuth,
  deleteBrowserProfileStorage,
} from '../../../src/security/browser-profile-storage.mjs';
import {
  performWebAuthnAssertion,
  resolveWebAuthnPaneBounds,
} from '../../../src/security/webauthn/orchestrator.mjs';

test('Browser Profile Policy: partition routing preserves Main partitions and isolates custom profiles', () => {
  assert.equal(isValidBrowserProfileId('main'), true);
  assert.equal(isValidBrowserProfileId('work-profile_1'), true);
  assert.equal(isValidBrowserProfileId('../escape'), false);
  assert.equal(isValidBrowserProfileId(''), false);

  assert.equal(partitionForBrowserProfile('main', 'chatgpt'), 'persist:maw-chatgpt');
  assert.equal(partitionForBrowserProfile('main', 'github'), 'persist:maw-github');
  assert.equal(partitionForBrowserProfile('main', 'perplexity'), 'persist:maw-perplexity');
  assert.equal(partitionForBrowserProfile('main', 'other'), 'persist:maw-browser');
  assert.equal(partitionForBrowserProfile(undefined, 'chatgpt'), 'persist:maw-chatgpt');

  assert.equal(partitionForBrowserProfile('client-a', 'chatgpt'), 'persist:maw-profile-client-a-chatgpt');
  assert.equal(partitionForBrowserProfile('client-a', 'github'), 'persist:maw-profile-client-a-github');
  assert.equal(partitionForBrowserProfile('client-a', 'perplexity'), 'persist:maw-profile-client-a-perplexity');
  assert.equal(partitionForBrowserProfile('client-a', 'other'), 'persist:maw-profile-client-a-browser');
});

test('Browser Profile Policy: validCommand validates open, update, clone-profile, and clear-profile-site-auth', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  assert.equal(
    validCommand({ type: 'open', id, url: 'https://chatgpt.com/', provider: 'chatgpt', profileId: 'work-1' }),
    true,
  );
  assert.equal(
    validCommand({ type: 'update', id, url: 'https://github.com/', provider: 'github', profileId: 'work-1' }),
    true,
  );
  assert.equal(
    validCommand({ type: 'open', id, url: 'https://chatgpt.com/', provider: 'chatgpt', profileId: '../bad' }),
    false,
  );
  assert.equal(
    validCommand({
      type: 'clone-profile',
      sourceProfileId: DEFAULT_BROWSER_PROFILE_ID,
      targetProfileId: 'work-clone',
      clearSites: ['chatgpt', 'github'],
    }),
    true,
  );
  // Cannot overwrite main profile or clone onto self
  assert.equal(
    validCommand({
      type: 'clone-profile',
      sourceProfileId: 'work-1',
      targetProfileId: DEFAULT_BROWSER_PROFILE_ID,
    }),
    false,
  );
  assert.equal(
    validCommand({
      type: 'clone-profile',
      sourceProfileId: 'work-1',
      targetProfileId: 'work-1',
    }),
    false,
  );
  assert.equal(
    validCommand({
      type: 'clear-profile-site-auth',
      profileId: 'work-1',
      site: 'perplexity',
    }),
    true,
  );
  assert.equal(
    validCommand({
      type: 'clear-profile-site-auth',
      profileId: 'work-1',
      site: 'invalid-site',
    }),
    false,
  );
  assert.equal(
    validCommand({
      type: 'delete-profile',
      profileId: 'work-1',
    }),
    true,
  );
  assert.equal(
    validCommand({
      type: 'delete-profile',
      profileId: DEFAULT_BROWSER_PROFILE_ID,
    }),
    false,
  );
  assert.equal(
    validCommand({
      type: 'delete-profile',
      profileId: '../escape',
    }),
    false,
  );
});

test('Browser Profile Storage: cloneBrowserProfileStorage copies cookies, honors clearSites, and leaves source untouched', async () => {
  const partitions = new Map();
  function getPartition(name) {
    if (!partitions.has(name)) {
      partitions.set(name, {
        cookiesList: [],
        cleared: 0,
        flushed: 0,
        flushStorageData() {
          this.flushed += 1;
        },
        async clearStorageData() {
          this.cleared += 1;
          this.cookiesList = [];
        },
        async clearAuthCache() {},
        cookies: {
          async flushStore() {},
          async get() {
            return [...partitions.get(name).cookiesList];
          },
          async set(details) {
            partitions.get(name).cookiesList.push(details);
          },
        },
      });
    }
    return partitions.get(name);
  }

  getPartition('persist:maw-chatgpt').cookiesList.push({
    name: '__Secure-next-auth.session-token',
    value: 'secret-token',
    domain: '.chatgpt.com',
    path: '/',
    secure: true,
    httpOnly: true,
    hostOnly: false,
    sameSite: 'lax',
  });
  getPartition('persist:maw-github').cookiesList.push({
    name: '__Host-user_session_same_site',
    value: 'gh-secret',
    domain: 'github.com',
    path: '/',
    secure: true,
    httpOnly: true,
    hostOnly: true,
    sameSite: 'strict',
  });

  const sessionApi = { fromPartition: (name) => getPartition(name) };

  const res = await cloneBrowserProfileStorage({
    sessionApi,
    sourceProfileId: 'main',
    targetProfileId: 'work',
    clearSites: ['github'],
  });

  assert.equal(res.ok, true);
  assert.deepEqual(res.clearedSites, ['github']);
  assert.ok(res.clonedSites.includes('chatgpt'));
  assert.equal(res.cookiesCopied, 1);

  // Source github cookies remain untouched
  assert.equal(getPartition('persist:maw-github').cookiesList.length, 1);
  // The excluded site was left empty.
  assert.equal(getPartition('persist:maw-profile-work-github').cookiesList.length, 0);
  assert.equal(getPartition('persist:maw-profile-work-github').cleared, 0);
  // Target chatgpt partition received the cloned cookie
  assert.equal(getPartition('persist:maw-profile-work-chatgpt').cookiesList.length, 1);
  assert.equal(getPartition('persist:maw-profile-work-chatgpt').cookiesList[0].name, '__Secure-next-auth.session-token');
  await assert.rejects(cloneBrowserProfileStorage({
    sessionApi, sourceProfileId: 'main', targetProfileId: 'work',
  }), /destination already contains cookies/);

  // Clear site auth on target chatgpt partition
  const clearRes = await clearProfileSiteAuth({
    sessionApi,
    profileId: 'work',
    site: 'chatgpt',
  });
  assert.equal(clearRes.ok, true);
  assert.equal(getPartition('persist:maw-profile-work-chatgpt').cookiesList.length, 0);

  // Check __Host- cookie conversion omits domain attribute and rejects non-root path
  const hostCookie = toCookieSetDetails({
    name: '__Host-session',
    value: 'abc',
    domain: 'chatgpt.com',
    path: '/',
    secure: true,
    httpOnly: true,
    hostOnly: true,
  });
  assert.equal(hostCookie.domain, undefined);
  assert.equal(hostCookie.url, 'https://chatgpt.com/');
  assert.equal(toCookieSetDetails({
    name: '__Host-badpath',
    value: 'abc',
    domain: 'chatgpt.com',
    path: '/sub',
    secure: true,
  }), null);
  // Expired persistent cookies are skipped
  assert.equal(toCookieSetDetails({
    name: 'old',
    value: '1',
    domain: 'chatgpt.com',
    path: '/',
    session: false,
    expirationDate: 1000,
  }), null);
});

test('Browser Profile Storage: clone skips individual bad cookies, clearSiteAuth clears cache, deleteProfileStorage wipes all partitions', async () => {
  const partitions = new Map();
  function getPartition(name) {
    if (!partitions.has(name)) {
      partitions.set(name, {
        cookiesList: [],
        clearedStorage: 0,
        clearedCache: 0,
        clearedAuthCache: 0,
        flushed: 0,
        flushStorageData() {
          this.flushed += 1;
        },
        async clearStorageData() {
          this.clearedStorage += 1;
          this.cookiesList = [];
        },
        async clearCache() {
          this.clearedCache += 1;
        },
        async clearAuthCache() {
          this.clearedAuthCache += 1;
        },
        cookies: {
          async flushStore() {},
          async get() {
            return [...partitions.get(name).cookiesList];
          },
          async set(details) {
            if (details.name === 'reject_on_set') {
              throw new Error('Chromium rejected cookie');
            }
            partitions.get(name).cookiesList.push(details);
          },
          async remove() {},
        },
      });
    }
    return partitions.get(name);
  }

  getPartition('persist:maw-chatgpt').cookiesList.push(
    { name: 'good_cookie', value: 'ok', domain: '.chatgpt.com', path: '/', secure: true },
    { name: '', value: 'empty-name', domain: '.chatgpt.com', path: '/' },
    { name: 'expired_cookie', value: 'old', domain: '.chatgpt.com', path: '/', session: false, expirationDate: 10 },
    { name: 'reject_on_set', value: 'bad', domain: '.chatgpt.com', path: '/', secure: true },
  );

  const sessionApi = { fromPartition: (name) => getPartition(name) };

  const cloneRes = await cloneBrowserProfileStorage({
    sessionApi,
    sourceProfileId: 'main',
    targetProfileId: 'work-partial',
  });
  assert.equal(cloneRes.ok, true);
  assert.equal(cloneRes.cookiesCopied, 1);
  assert.equal(cloneRes.cookiesSkipped, 3);
  assert.equal(getPartition('persist:maw-profile-work-partial-chatgpt').cookiesList.length, 1);
  assert.equal(getPartition('persist:maw-profile-work-partial-chatgpt').cookiesList[0].name, 'good_cookie');

  // clearProfileSiteAuth clears storage, HTTP cache, and auth cache
  const clearRes = await clearProfileSiteAuth({
    sessionApi,
    profileId: 'work-partial',
    site: 'chatgpt',
  });
  assert.equal(clearRes.ok, true);
  const clearedPart = getPartition('persist:maw-profile-work-partial-chatgpt');
  assert.equal(clearedPart.clearedStorage, 1);
  assert.equal(clearedPart.clearedCache, 1);
  assert.equal(clearedPart.clearedAuthCache, 1);

  // deleteBrowserProfileStorage wipes all 4 site partitions and rejects 'main'
  await assert.rejects(
    () => deleteBrowserProfileStorage({ sessionApi, profileId: 'main' }),
    /Invalid custom browser profile ID/,
  );
  const delRes = await deleteBrowserProfileStorage({
    sessionApi,
    profileId: 'work-partial',
  });
  assert.equal(delRes.ok, true);
  assert.equal(delRes.clearedPartitions.length, 4);
  for (const partName of delRes.clearedPartitions) {
    const part = getPartition(partName);
    assert.ok(part.clearedStorage >= 1, `${partName} storage cleared`);
    assert.ok(part.clearedCache >= 1, `${partName} cache cleared`);
    assert.ok(part.clearedAuthCache >= 1, `${partName} auth cache cleared`);
  }
});

test('WebAuthn Orchestrator: popup bounds resolution, PIN retries, multi-device iteration, and resident credentials', async () => {
  const mainWin = { id: 1 };
  const popupWin = { id: 2 };
  const sender = { id: 10 };
  const attachedViews = new Map([
    ['tab-1', { webContents: sender, getBounds: () => ({ x: 50, y: 60, width: 500, height: 400 }) }],
  ]);

  // Popup window returns null bounds so PIN dialog centers inside popup window
  assert.equal(
    resolveWebAuthnPaneBounds({ parentWin: popupWin, mainWin, senderWebContents: sender, attachedViews }),
    null,
  );
  // Main window view returns pane bounds
  assert.deepEqual(
    resolveWebAuthnPaneBounds({ parentWin: mainWin, mainWin, senderWebContents: sender, attachedViews }),
    { x: 50, y: 60, width: 500, height: 400 },
  );

  // Multi-device + PIN retry + resident credential discovery
  let pinPrompts = 0;
  let assertCalls = 0;
  const result = await performWebAuthnAssertion({
    options: {
      rpId: 'chatgpt.com',
      challenge: 'Y2hhbGxlbmdl',
      allowCredentials: [],
      userVerification: 'required',
    },
    origin: 'https://chatgpt.com',
    parentWin: popupWin,
    paneBounds: null,
    deps: {
      discoverFido2Devices: async () => [{ path: '/dev/hidraw0' }, { path: '/dev/hidraw1' }],
      getDeviceCapabilities: async () => ({ hasClientPin: true, pinRetries: 3, uv: true }),
      requestPinDialog: async ({ error }) => {
        pinPrompts += 1;
        if (pinPrompts === 2) assert.match(error, /Incorrect PIN/);
        return pinPrompts === 1 ? 'wrong-pin' : '123456';
      },
      listResidentCredentials: async ({ devicePath, rpId, pin }) => {
        assert.equal(devicePath, '/dev/hidraw1');
        assert.equal(rpId, 'chatgpt.com');
        assert.equal(pin, '123456');
        return [{ credentialId: 'Y3JlZC1pZC0x', userId: 'dXNlcg' }];
      },
      executeAssertion: async ({ devicePath, isResident, pin }) => {
        assert.equal(isResident, true);
        if (pin === 'wrong-pin') throw new Error('FIDO_ERR_PIN_INVALID');
        if (devicePath === '/dev/hidraw0') throw new Error('FIDO_ERR_NO_CREDENTIALS');
        assertCalls += 1;
        assert.equal(devicePath, '/dev/hidraw1');
        assert.equal(pin, '123456');
        const authData = Buffer.concat([createHash('sha256').update('chatgpt.com').digest(), Buffer.from([5, 0, 0, 0, 0])]);
        return [Buffer.concat([Buffer.from([0x58, authData.length]), authData]).toString('base64'), 'c2ln', 'dXNlcg=='].join('\n');
      },
    },
  });

  assert.equal(result.success, true);
  assert.equal(pinPrompts, 3);
  assert.equal(assertCalls, 1);
  assert.equal(result.data.credentialId, 'Y3JlZC1pZC0x');
});

test('WebAuthn rejects malformed allow-lists and does not downgrade required verification', async () => {
  const origin = 'https://chatgpt.com';
  const options = { rpId: 'chatgpt.com', challenge: 'Y2hhbGxlbmdl', userVerification: 'required' };
  let discoveryCalls = 0;
  let assertionCalls = 0;
  const deps = {
    discoverFido2Devices: async () => { discoveryCalls++; return [{ path: '/dev/hidraw0' }]; },
    getDeviceCapabilities: async () => ({ hasClientPin: false }),
    executeAssertion: async () => { assertionCalls++; },
  };
  const invalid = await performWebAuthnAssertion({
    options: { ...options, allowCredentials: [{ type: 'public-key', id: 'invalid encoding' }] },
    origin, deps,
  });
  assert.equal(invalid.success, false);
  assert.equal(invalid.error.name, 'SecurityError');
  assert.equal(discoveryCalls, 0);
  const unverifiable = await performWebAuthnAssertion({ options, origin, deps });
  assert.equal(unverifiable.success, false);
  assert.equal(unverifiable.error.name, 'NotAllowedError');
  assert.equal(assertionCalls, 0);
});

test('WebAuthn Orchestrator honors AbortSignal and normalizes mixed-case rpId', async () => {
  const controller = new AbortController();
  let assertionSignal = null;
  let capturedRpId = null;

  // Aborting during assertion returns NotAllowedError cleanly
  const abortedPromise = performWebAuthnAssertion({
    options: { rpId: 'ChatGPT.COM', challenge: 'Y2hhbGxlbmdl', userVerification: 'discouraged' },
    origin: 'https://chatgpt.com',
    signal: controller.signal,
    deps: {
      discoverFido2Devices: async () => [{ path: '/dev/hidraw0' }],
      getDeviceCapabilities: async () => ({ hasClientPin: false }),
      executeAssertion: async ({ rpId, signal }) => {
        capturedRpId = rpId;
        assertionSignal = signal;
        controller.abort();
        throw new Error('NotAllowedError: security key operation cancelled');
      },
    },
  });
  const aborted = await abortedPromise;
  assert.equal(capturedRpId, 'chatgpt.com');
  assert.equal(assertionSignal, controller.signal);
  assert.equal(aborted.success, false);
  assert.equal(aborted.error.name, 'NotAllowedError');
  assert.match(aborted.error.message, /cancelled/i);

  // Already-aborted signal short-circuits before discovery
  let discoveryCalled = false;
  const preAborted = await performWebAuthnAssertion({
    options: { rpId: 'chatgpt.com', challenge: 'Y2hhbGxlbmdl' },
    origin: 'https://chatgpt.com',
    signal: controller.signal,
    deps: {
      discoverFido2Devices: async () => { discoveryCalled = true; return []; },
    },
  });
  assert.equal(discoveryCalled, false);
  assert.equal(preAborted.success, false);
  assert.equal(preAborted.error.name, 'NotAllowedError');
});
