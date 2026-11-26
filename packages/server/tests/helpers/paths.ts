import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HELPERS_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Root directory of `@anvilary/workbench-server`. */
export const SERVER_ROOT = path.resolve(HELPERS_DIR, '..', '..');

/** Source directory of `@anvilary/workbench-server`. */
export const SERVER_SRC = path.join(SERVER_ROOT, 'src');

/** Monorepo root directory. */
export const REPO_ROOT = path.resolve(SERVER_ROOT, '..', '..');

/** Root directory of `@anvilary/workbench-web`. */
export const WEB_ROOT = path.join(REPO_ROOT, 'packages', 'web');

/** Root directory of `@anvilary/workbench-desktop`. */
export const DESKTOP_ROOT = path.join(REPO_ROOT, 'packages', 'desktop');

/** Directory containing MAW lifecycle and launch scripts. */
export const SCRIPTS_MAW_DIR = path.join(REPO_ROOT, 'scripts', 'maw');
