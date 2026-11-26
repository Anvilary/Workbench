export function migrateConfigDir(paths: { legacyDir: string; canonicalDir: string }): {
  migrated: boolean;
  reason: string;
  legacyDir: string;
  canonicalDir: string;
  files: number;
};
