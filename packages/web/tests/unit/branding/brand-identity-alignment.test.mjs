import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../../../../../');
const canonicalDir = process.env.CANONICAL_BRAND_DIR || '';

test('UI-04: Favicons match canonical Anvilary Tools logo byte-for-byte', () => {
  const icoPath = path.join(repoRoot, 'packages/web/public/favicon.ico');
  const png32Path = path.join(repoRoot, 'packages/web/public/favicon-32x32.png');
  const png16Path = path.join(repoRoot, 'packages/web/public/favicon-16x16.png');
  const applePath = path.join(repoRoot, 'packages/web/public/apple-touch-icon.png');

  assert.ok(existsSync(icoPath), 'favicon.ico must exist');
  assert.ok(existsSync(png32Path), 'favicon-32x32.png must exist');
  assert.ok(existsSync(png16Path), 'favicon-16x16.png must exist');
  assert.ok(existsSync(applePath), 'apple-touch-icon.png must exist');

  if (canonicalDir && existsSync(canonicalDir)) {
    const expectedIco = readFileSync(path.join(canonicalDir, 'favicons/favicon.ico'));
    const actualIco = readFileSync(icoPath);
    assert.deepEqual(actualIco, expectedIco, 'favicon.ico must match canonical favicon.ico exactly');

    const expected32 = readFileSync(path.join(canonicalDir, 'favicons/favicon-32x32.png'));
    const actual32 = readFileSync(png32Path);
    assert.deepEqual(actual32, expected32, 'favicon-32x32.png must match canonical favicon-32x32.png exactly');

    const expected16 = readFileSync(path.join(canonicalDir, 'favicons/favicon-16x16.png'));
    const actual16 = readFileSync(png16Path);
    assert.deepEqual(actual16, expected16, 'favicon-16x16.png must match canonical favicon-16x16.png exactly');

    const expectedApple = readFileSync(path.join(canonicalDir, 'app-icons/apple-touch-icon-180.png'));
    const actualApple = readFileSync(applePath);
    assert.deepEqual(actualApple, expectedApple, 'apple-touch-icon.png must match canonical apple-touch-icon-180.png exactly');
  }
});

test('UI-04: Web app brand logos match canonical Anvilary Tools transparent logo byte-for-byte', () => {
  const sizes = [16, 32, 128, 256, 512];
  for (const s of sizes) {
    const targetPath = path.join(repoRoot, `packages/web/public/brand/workbench-logo-${s}.png`);
    const internalCanonical = path.join(repoRoot, `packages/web/public/brand/anvilary-tools-${s}.png`);
    assert.ok(existsSync(targetPath), `workbench-logo-${s}.png must exist`);
    assert.ok(existsSync(internalCanonical), `anvilary-tools-${s}.png must exist`);
    const actual = readFileSync(targetPath);
    const expectedInternal = readFileSync(internalCanonical);
    assert.deepEqual(actual, expectedInternal, `workbench-logo-${s}.png must match repository canonical brand logo of size ${s}`);

    if (canonicalDir && existsSync(canonicalDir)) {
      const expected = readFileSync(path.join(canonicalDir, `png/transparent/anvilary-tools-${s}.png`));
      assert.deepEqual(actual, expected, `workbench-logo-${s}.png must match canonical transparent logo of size ${s}`);
    }
  }
});

test('UI-04: Desktop application icon and launcher icons match canonical Anvilary Tools logo', () => {
  const electronIcon = path.join(repoRoot, 'packages/desktop/icon.png');
  assert.ok(existsSync(electronIcon), 'packages/desktop/icon.png must exist');
  const internal512 = path.join(repoRoot, 'packages/web/public/brand/anvilary-tools-512.png');
  assert.deepEqual(readFileSync(electronIcon), readFileSync(internal512), 'packages/desktop/icon.png must match canonical 512 logo');

  const launcherSizes = [16, 24, 32, 48, 64, 96, 128, 192, 256, 512];
  for (const s of launcherSizes) {
    const launcherIcon = path.join(repoRoot, `packages/desktop/assets/icons/workbench-${s}.png`);
    assert.ok(existsSync(launcherIcon), `maw-${s}.png must exist`);
    if ([16, 32, 128, 256, 512].includes(s)) {
      const internalCanonical = path.join(repoRoot, `packages/web/public/brand/anvilary-tools-${s}.png`);
      assert.deepEqual(readFileSync(launcherIcon), readFileSync(internalCanonical), `maw-${s}.png must match repository canonical brand logo size ${s}`);
    }
    if (canonicalDir && existsSync(canonicalDir)) {
      const expected = readFileSync(path.join(canonicalDir, `png/transparent/anvilary-tools-${s}.png`));
      assert.deepEqual(readFileSync(launcherIcon), expected, `maw-${s}.png must match canonical transparent logo size ${s}`);
    }
  }
});

test('UI-04: index.html and site.webmanifest contain consistent references', () => {
  const htmlPath = path.join(repoRoot, 'packages/web/index.html');
  const html = readFileSync(htmlPath, 'utf8');

  assert.ok(html.includes('<link rel="icon" type="image/x-icon" href="/favicon.ico" />'), 'HTML must reference favicon.ico');
  assert.ok(html.includes('<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png" />'), 'HTML must reference favicon-32x32.png');
  assert.ok(html.includes('<link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png" />'), 'HTML must reference favicon-16x16.png');
  assert.ok(html.includes('<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />'), 'HTML must reference apple-touch-icon.png');
  assert.ok(html.includes('<link rel="manifest" href="/site.webmanifest" />'), 'HTML must reference site.webmanifest');

  const manifestPath = path.join(repoRoot, 'packages/web/public/site.webmanifest');
  assert.ok(existsSync(manifestPath), 'site.webmanifest must exist');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.name, 'Anvilary Workbench');
  assert.equal(manifest.short_name, 'Workbench');
  assert.equal(manifest.display, 'standalone');
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 4);

  for (const icon of manifest.icons) {
    const iconRelative = icon.src.startsWith('/') ? icon.src.slice(1) : icon.src;
    const file = path.join(repoRoot, 'packages/web/public', iconRelative);
    assert.ok(existsSync(file), `Manifest icon ${icon.src} must exist at ${file}`);
  }
});
