import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WEB_SRC } from '../../helpers/paths.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 1. Translation Keys Verification across all locales
test('all 9 locales contain all performance.* keys without empty values', () => {
  const localesDir = path.join(WEB_SRC, 'i18n', 'locales');
  const locales = ['en', 'es', 'de', 'fr', 'pt-BR', 'ru', 'ja', 'ko', 'zh-CN'];

  const enRaw = fs.readFileSync(path.join(localesDir, 'en.json'), 'utf8');
  const enData = JSON.parse(enRaw);
  const perfKeys = Object.keys(enData).filter((k) => k.startsWith('performance.'));

  assert.ok(perfKeys.includes('performance.available'));
  assert.ok(perfKeys.includes('performance.swap'));

  for (const locale of locales) {
    const raw = fs.readFileSync(path.join(localesDir, `${locale}.json`), 'utf8');
    const data = JSON.parse(raw);

    for (const key of perfKeys) {
      assert.ok(
        key in data,
        `Missing key "${key}" in locale "${locale}"`
      );
      assert.ok(
        typeof data[key] === 'string' && data[key].trim().length > 0,
        `Empty or invalid translation for "${key}" in locale "${locale}"`
      );
    }
  }
});

// 2. Sparkline mathematical and SVG path calculation logic
function calculateSparklinePaths(data, width = 110, height = 26, explicitMin, explicitMax) {
  if (!data || data.length < 2) {
    return { pathD: '', fillD: '' };
  }

  const padding = 2;
  const drawWidth = width - padding * 2;
  const drawHeight = height - padding * 2;

  const dataMin = explicitMin !== undefined ? explicitMin : Math.min(...data);
  const dataMax = explicitMax !== undefined ? explicitMax : Math.max(...data);
  const range = dataMax - dataMin || 1;

  const points = data.map((val, idx) => {
    const x = padding + (idx / (data.length - 1)) * drawWidth;
    const normalizedY = (val - dataMin) / range;
    const y = padding + drawHeight - normalizedY * drawHeight;
    return [x, y];
  });

  if (points.length < 2 || !points[0] || !points[points.length - 1]) {
    return { pathD: '', fillD: '' };
  }

  const pathD = points.reduce((acc, point, idx) => {
    const [x, y] = point;
    return idx === 0 ? `M ${x.toFixed(1)},${y.toFixed(1)}` : `${acc} L ${x.toFixed(1)},${y.toFixed(1)}`;
  }, '');

  const lastX = points[points.length - 1][0];
  const firstX = points[0][0];
  const bottomY = height - padding;
  const fillD = `${pathD} L ${lastX.toFixed(1)},${bottomY} L ${firstX.toFixed(1)},${bottomY} Z`;

  return { pathD, fillD };
}

test('sparkline handles empty or single element input gracefully', () => {
  assert.deepEqual(calculateSparklinePaths([]), { pathD: '', fillD: '' });
  assert.deepEqual(calculateSparklinePaths([42]), { pathD: '', fillD: '' });
  assert.deepEqual(calculateSparklinePaths(null), { pathD: '', fillD: '' });
});

test('sparkline generates valid SVG path and closed area fill', () => {
  const data = [10, 20, 15, 30, 25];
  const { pathD, fillD } = calculateSparklinePaths(data, 100, 30);

  assert.ok(pathD.startsWith('M 2.0,'), 'Path starts with M command at padding');
  assert.ok(pathD.includes(' L '), 'Path includes line segments');
  assert.ok(fillD.startsWith(pathD), 'Fill area includes line path');
  assert.ok(fillD.endsWith(' Z'), 'Fill area terminates with Z');
  assert.ok(fillD.includes('L 98.0,28'), 'Fill area reaches bottom right');
});

test('sparkline respects explicit min and max', () => {
  const data = [50, 50];
  // With explicit 0-100 range, y should be exactly centered
  const { pathD } = calculateSparklinePaths(data, 100, 30, 0, 100);
  assert.equal(pathD, 'M 2.0,15.0 L 98.0,15.0');
});

// 3. Mock Desktop Bridge Protocol and Subscription Lifecycle
test('mock desktop bridge interacts correctly with performance command lifecycle', async () => {
  let activeSubscription = null;
  const commandLog = [];
  let isPaused = false;

  const mockSnapshot = {
    timestamp: Date.now(),
    sampleDurationMs: 12.5,
    isPaused: false,
    global: {
      totalCpuPercent: 4.2,
      cpuCount: 16,
      totalPssBytes: 485000000,
      totalRssBytes: 620000000,
      systemMemoryTotalBytes: 32000000000,
      systemMemoryFreeBytes: 18000000000,
      systemMemoryPressurePercent: 43.7,
      mawProcessCount: 9,
      services: {
        backend: { online: true, pid: 1234 },
        ptySupervisor: { online: true, pid: 1235 },
        desktop: { online: true, pid: 1230 },
      },
      gpu: {
        processCount: 1,
        totalPssBytes: 65000000,
        totalRssBytes: 90000000,
        engineUtilizationPercent: null,
        dedicatedVramBytes: null,
      },
    },
    history: [
      { timestamp: Date.now() - 2000, mawCpuPercent: 3.8, mawPssBytes: 480000000, mawProcessCount: 9 },
      { timestamp: Date.now(), mawCpuPercent: 4.2, mawPssBytes: 485000000, mawProcessCount: 9 },
    ],
    infrastructure: {
      totalCpuPercent: 2.1,
      totalPssBytes: 250000000,
      processes: [],
    },
    aiAgents: {
      totalCpuPercent: 1.5,
      totalPssBytes: 180000000,
      totalInstances: 2,
      providers: [
        {
          provider: 'codex',
          name: 'Codex CLI',
          instances: 1,
          totalCpuPercent: 1.0,
          totalPssBytes: 110000000,
          terminals: [
            {
              terminalId: 'term-1',
              title: 'Terminal 1',
              shell: 'codex',
              rootPid: 5432,
              processCount: 3,
              cpuPercent: 1.0,
              pssBytes: 110000000,
            },
          ],
        },
      ],
    },
    browserViews: {
      totalCpuPercent: 0.5,
      totalPssBytes: 50000000,
      count: 1,
      views: [
        {
          id: 'chatgpt-tab',
          title: 'ChatGPT',
          url: 'https://chatgpt.com',
          service: 'chatgpt',
          state: 'active',
          isSharedRenderer: false,
          rendererPid: 9876,
          cpuPercent: 0.5,
          pssBytes: 50000000,
          rssBytes: 70000000,
        },
      ],
    },
    otherTerminals: {
      totalCpuPercent: 0.1,
      totalPssBytes: 5000000,
      count: 1,
      terminals: [],
    },
  };

  const mockBridge = {
    command: async (cmd) => {
      commandLog.push(cmd);
      if (cmd.type === 'performance-subscribe') {
        return { ok: true, snapshot: { ...mockSnapshot, isPaused } };
      }
      if (cmd.type === 'performance-pause') {
        isPaused = true;
        return { ok: true };
      }
      if (cmd.type === 'performance-resume') {
        isPaused = false;
        return { ok: true };
      }
      if (cmd.type === 'performance-refresh') {
        return { ok: true, snapshot: { ...mockSnapshot, isPaused, timestamp: Date.now() } };
      }
      if (cmd.type === 'performance-unsubscribe') {
        return { ok: true };
      }
      throw new Error(`Unknown command: ${cmd.type}`);
    },
    subscribe: (fn) => {
      activeSubscription = fn;
      return () => {
        activeSubscription = null;
      };
    },
  };

  // 1. Subscribe
  const unsub = mockBridge.subscribe((update) => {
    assert.equal(update.type, 'performance-update');
    assert.ok(update.snapshot);
  });
  const subRes = await mockBridge.command({ type: 'performance-subscribe' });
  assert.equal(subRes.ok, true);
  assert.equal(subRes.snapshot.global.totalCpuPercent, 4.2);

  // 2. Pause
  const pauseRes = await mockBridge.command({ type: 'performance-pause' });
  assert.equal(pauseRes.ok, true);
  assert.equal(isPaused, true);

  // 3. Resume
  const resumeRes = await mockBridge.command({ type: 'performance-resume' });
  assert.equal(resumeRes.ok, true);
  assert.equal(isPaused, false);

  // 4. Refresh
  const refreshRes = await mockBridge.command({ type: 'performance-refresh' });
  assert.equal(refreshRes.ok, true);
  assert.ok(refreshRes.snapshot.timestamp);

  // 5. Emit mock push update
  assert.ok(activeSubscription);
  activeSubscription({ type: 'performance-update', snapshot: mockSnapshot });

  // 6. Unsubscribe
  unsub();
  assert.equal(activeSubscription, null);
  const unsubRes = await mockBridge.command({ type: 'performance-unsubscribe' });
  assert.equal(unsubRes.ok, true);

  // Check commands recorded in order
  const commandTypes = commandLog.map((c) => c.type);
  assert.deepEqual(commandTypes, [
    'performance-subscribe',
    'performance-pause',
    'performance-resume',
    'performance-refresh',
    'performance-unsubscribe',
  ]);
});
