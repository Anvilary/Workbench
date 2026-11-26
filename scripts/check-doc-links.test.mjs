// Run: node --test scripts/check-doc-links.test.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkLink, checkRepository, collectAnchors, extractLinks, slugify } from './check-doc-links.mjs';

test('slugify follows GitHub heading rules', () => {
  assert.equal(slugify('5. Output Replay & Monotonic Offset Contract'), '5-output-replay--monotonic-offset-contract');
  assert.equal(slugify('Launcher and CLI (`anvi-bench`)'), 'launcher-and-cli-anvi-bench');
  assert.equal(slugify('Gemeinsames Gedächtnis für alle CLIs'), 'gemeinsames-gedächtnis-für-alle-clis');
  assert.equal(slugify('See [the guide](x.md) **now**'), 'see-the-guide-now');
});

test('anchors include duplicates, explicit ids and ignore fenced code', () => {
  const anchors = collectAnchors('# Title\n## Part\n## Part\n<a id="custom"></a>\n```\n# not a heading\n```\n');
  assert.ok(anchors.has('title'));
  assert.ok(anchors.has('part'));
  assert.ok(anchors.has('part-1'));
  assert.ok(anchors.has('custom'));
  assert.ok(!anchors.has('not-a-heading'));
});

test('links are extracted outside code, including images, titles and references', () => {
  const links = extractLinks('[a](one.md) ![i](img.png "t") `[x](code.md)`\n```\n[y](fenced.md)\n```\n[ref]: <two.md#x>\n');
  assert.deepEqual(links.map((l) => l.target), ['one.md', 'img.png', 'two.md#x']);
});

test('external links are skipped; missing files and anchors are reported', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'doc-links-'));
  try {
    mkdirSync(path.join(root, 'docs'));
    writeFileSync(path.join(root, 'docs', 'a.md'), '# Alpha\n## Beta\n');
    assert.equal(checkLink(root, 'README.md', 'https://example.com/x'), null);
    assert.equal(checkLink(root, 'README.md', 'mailto:user@example.com'), null);
    assert.equal(checkLink(root, 'README.md', 'docs/a.md#beta'), null);
    assert.equal(checkLink(root, 'docs/a.md', '#alpha'), null);
    assert.equal(checkLink(root, 'docs/a.md', '../docs'), null);
    assert.match(checkLink(root, 'README.md', 'docs/missing.md'), /missing target/);
    assert.match(checkLink(root, 'README.md', 'docs/a.md#gamma'), /missing anchor/);
    assert.match(checkLink(root, 'docs/a.md', '#nope'), /missing anchor/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('repository scan reports broken links and skips node_modules', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'doc-links-repo-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    writeFileSync(path.join(root, 'README.md'), '[ok](docs/a.md)\n[bad](docs/b.md)\n');
    mkdirSync(path.join(root, 'docs'));
    writeFileSync(path.join(root, 'docs', 'a.md'), '# A\n');
    mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(path.join(root, 'node_modules', 'pkg', 'README.md'), '[bad](nowhere.md)\n');
    const { files, problems } = checkRepository(root);
    assert.equal(files, 2);
    assert.deepEqual(problems, ['README.md:2: missing target docs/b.md']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
