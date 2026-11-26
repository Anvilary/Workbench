import type { WorkspaceId } from '@anvilary/workbench-shared';

/**
 * Shared per-workspace reservation mutex used across Lane A and Lane C.
 * Guarantees that session reservations and workspace deletion are strictly
 * serialized on the exact same workspace ID.
 */
export class WorkspaceMutex {
  private tails = new Map<string, Promise<unknown>>();

  runExclusive<T>(id: string | WorkspaceId, work: () => Promise<T>): Promise<T> {
    const key = String(id);
    const prev = this.tails.get(key) ?? Promise.resolve();
    let resolveNext!: () => void;
    const next = new Promise<void>((r) => { resolveNext = r; });
    this.tails.set(key, next);

    return prev
      .catch(() => undefined)
      .then(async () => {
        try {
          return await work();
        } finally {
          if (this.tails.get(key) === next) {
            this.tails.delete(key);
          }
          resolveNext();
        }
      });
  }
}
