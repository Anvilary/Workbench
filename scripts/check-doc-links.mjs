#!/usr/bin/env node
/**
 * Markdown link checker (no dependencies).
 *
 *   node scripts/check-doc-links.mjs [root]
 *
 * Checks every markdown file in the repository (tracked and untracked but not
 * ignored, excluding node_modules): relative links and images must point to an
 * existing file or directory, and `#anchor` fragments into markdown files must
 * match a heading (GitHub slug rules) or an explicit HTML id/name. External
 * links (any URL scheme) are not checked. Exits 1 when a link is broken.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** GitHub heading slug (github-slugger semantics, without duplicate suffixes). */
export function slugify(heading) {
  const text = heading
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .trim()
    .toLowerCase();
  return text.replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '').replace(/ /g, '-');
}

/** Lines outside fenced code blocks; inline code spans are blanked unless `keepInlineCode`. */
function proseLines(text, keepInlineCode = false) {
  const lines = text.split('\n');
  const out = [];
  let fence = null;
  for (const line of lines) {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (fence === null) fence = marker[1][0];
      else if (marker[1][0] === fence) fence = null;
      out.push('');
      continue;
    }
    if (fence !== null) out.push('');
    else out.push(keepInlineCode ? line : line.replace(/(`+)[^`]*?\1/g, (m) => ' '.repeat(m.length)));
  }
  return out;
}

/** Every anchor a markdown document defines. */
export function collectAnchors(text) {
  const anchors = new Set();
  const counts = new Map();
  // Headings keep their code spans: GitHub slugs include the code text.
  for (const line of proseLines(text, true)) {
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/);
    if (heading) {
      const base = slugify(heading[1]);
      const seen = counts.get(base) ?? 0;
      anchors.add(seen === 0 ? base : `${base}-${seen}`);
      counts.set(base, seen + 1);
    }
    for (const match of line.matchAll(/<a\s[^>]*?(?:id|name)\s*=\s*["']([^"']+)["']/gi)) anchors.add(match[1]);
  }
  return anchors;
}

/** Link targets in a markdown document, as { line, target }. */
export function extractLinks(text) {
  const links = [];
  proseLines(text).forEach((line, index) => {
    for (const match of line.matchAll(/!?\[(?:[^\]\\]|\\.)*\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+["'(][^)]*)?\)/g)) {
      links.push({ line: index + 1, target: match[1].replace(/^<|>$/g, '') });
    }
    const reference = line.match(/^\s{0,3}\[[^\]]+\]:\s*(<[^>]*>|\S+)/);
    if (reference) links.push({ line: index + 1, target: reference[1].replace(/^<|>$/g, '') });
  });
  return links;
}

/** Problems with one link from `file` (repo-relative), or null when it resolves. */
export function checkLink(root, file, target, anchorCache = new Map()) {
  if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) return null;
  const hashIndex = target.indexOf('#');
  const rawPath = hashIndex === -1 ? target : target.slice(0, hashIndex);
  const anchor = hashIndex === -1 ? '' : target.slice(hashIndex + 1);
  let pathPart;
  try {
    pathPart = decodeURIComponent(rawPath.split('?')[0]);
  } catch {
    return `malformed link ${target}`;
  }
  const resolved = pathPart === ''
    ? path.join(root, file)
    : pathPart.startsWith('/') ? path.join(root, pathPart) : path.join(root, path.dirname(file), pathPart);
  if (!existsSync(resolved)) return `missing target ${target}`;
  if (!anchor || !resolved.endsWith('.md') || statSync(resolved).isDirectory()) return null;
  if (!anchorCache.has(resolved)) anchorCache.set(resolved, collectAnchors(readFileSync(resolved, 'utf8')));
  let decoded;
  try {
    decoded = decodeURIComponent(anchor);
  } catch {
    decoded = anchor;
  }
  return anchorCache.get(resolved).has(decoded.toLowerCase()) || anchorCache.get(resolved).has(decoded)
    ? null
    : `missing anchor ${target}`;
}

function markdownFiles(root) {
  const output = execFileSync('git', ['ls-files', '-z', '-co', '--exclude-standard', '--', '*.md'], {
    cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  return output.split('\0').filter((file) => file && !file.split('/').includes('node_modules'));
}

export function checkRepository(root) {
  const problems = [];
  const anchorCache = new Map();
  const files = markdownFiles(root).filter((file) => existsSync(path.join(root, file)));
  for (const file of files) {
    const text = readFileSync(path.join(root, file), 'utf8');
    for (const { line, target } of extractLinks(text)) {
      const problem = checkLink(root, file, target, anchorCache);
      if (problem) problems.push(`${file}:${line}: ${problem}`);
    }
  }
  return { files: files.length, problems };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const { files, problems } = checkRepository(root);
  for (const problem of problems) console.error(problem);
  if (problems.length > 0) {
    console.error(`check-doc-links: ${problems.length} broken link(s) in ${files} markdown file(s).`);
    process.exit(1);
  }
  console.log(`check-doc-links: ${files} markdown file(s), all relative links resolve.`);
}
