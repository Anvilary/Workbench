import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HELPERS_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Root directory of `@agent-workbench/web`. */
export const WEB_ROOT = path.resolve(HELPERS_DIR, '..', '..');

/** Source directory of `@agent-workbench/web`. */
export const WEB_SRC = path.join(WEB_ROOT, 'src');

/** Monorepo root directory. */
export const REPO_ROOT = path.resolve(WEB_ROOT, '..', '..');

/** Root directory of `@agent-workbench/server`. */
export const SERVER_ROOT = path.join(REPO_ROOT, 'packages', 'server');

/** Root directory of `@agent-workbench/desktop`. */
export const DESKTOP_ROOT = path.join(REPO_ROOT, 'packages', 'desktop');
