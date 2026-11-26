import fs from 'node:fs';
import path from 'node:path';

/** Copy standalone installation state once, preserving the original directory. */
export function migrateConfigDir({ legacyDir, canonicalDir }) {
  if (typeof legacyDir !== 'string' || !legacyDir) throw new TypeError('legacyDir is required');
  if (typeof canonicalDir !== 'string' || !canonicalDir) throw new TypeError('canonicalDir is required');
  const legacy = path.resolve(legacyDir);
  const canonical = path.resolve(canonicalDir);
  const report = (migrated, reason, files = 0) => ({
    migrated, reason, legacyDir: legacy, canonicalDir: canonical, files,
  });
  if (legacy === canonical) return report(false, 'same-directory');
  const source = fs.lstatSync(legacy, { throwIfNoEntry: false });
  if (!source?.isDirectory()) return report(false, 'no-legacy-config');
  const fileCount = () => fs.readdirSync(canonical, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() || entry.isSymbolicLink()).length;
  const present = () => fs.lstatSync(canonical, { throwIfNoEntry: false });
  const existing = present();
  if (existing) return report(false, 'canonical-exists', existing.isDirectory() ? fileCount() : 0);

  fs.mkdirSync(path.dirname(canonical), { recursive: true });
  const stagingRoot = fs.mkdtempSync(`${canonical}.migrating-`);
  const staging = path.join(stagingRoot, 'config');
  try {
    fs.cpSync(legacy, staging, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
    fs.chmodSync(staging, 0o700);
    fs.renameSync(staging, canonical);
  } catch (error) {
    const committed = present();
    if (committed) return report(false, 'canonical-exists', committed.isDirectory() ? fileCount() : 0);
    throw error;
  } finally {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
  }
  return report(true, 'copied', fileCount());
}
