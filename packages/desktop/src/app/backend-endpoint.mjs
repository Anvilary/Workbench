/**
 * The backend the shell talks to.
 *
 * Owns the current backend URL, which changes when the backend restarts on a new
 * port, and the shell storage carried across such a change.
 */

import { serviceUrl } from '../../policy.mjs';
import { discoverBackendReadiness } from '../ipc/backend-readiness.mjs';

export function createBackendEndpoint(initialUrl, { serviceUrl }) {
  let current = initialUrl;
  let pendingShellStorage = null;
  return {
    current: () => current,
    set: (url) => { current = url; },
    readiness: () => discoverBackendReadiness({ serviceUrl }),
    setPendingShellStorage: (storage) => { pendingShellStorage = storage; },
    takePendingShellStorage: () => {
      const storage = pendingShellStorage;
      pendingShellStorage = null;
      return storage;
    },
  };
}
