import path from 'node:path';
import {
  type WorkspaceId,
  type WorkspacePaneLayout,
  isWorkspacePaneLayout,
} from '@anvilary/workbench-shared';
import { writeAtomically } from '../../shared/persistence/atomic-write.js';
import { appConfigDir } from '../../shared/app-paths.js';
import { SerialQueue } from '../../shared/concurrency/serial-queue.js';
import {
  loadWithBackupRecovery,
  writeSnapshotWithBackup,
} from '../../shared/persistence/versioned-json-store.js';
import { isRecord } from '../../shared/validation/primitives.js';

const VERSION = 1;

class UnsupportedAgencyLayoutSchemaError extends Error {
  constructor(version: unknown) {
    super('Unsupported Agency layout store version: ' + String(version));
    this.name = 'UnsupportedAgencyLayoutSchemaError';
  }
}

export class AgencyLayoutStore {
  private readonly writeQueue = new SerialQueue();
  private readonly mutationQueue = new SerialQueue();
  private readonly layouts = new Map<WorkspaceId, WorkspacePaneLayout>();
  private initialized = false;

  constructor(
    readonly file: string = path.join(appConfigDir(), 'agency-layouts.json'),
    private readonly write: typeof writeAtomically = writeAtomically,
  ) {}

  async initialize(): Promise<void> {
    if (this.initialized) return;
    const loaded = await this.load();
    for (const layout of loaded) {
      this.layouts.set(layout.workspaceId, layout);
    }
    this.initialized = true;
  }

  async load(): Promise<WorkspacePaneLayout[]> {
    const result = await loadWithBackupRecovery({
      filePath: this.file,
      parse: (contents) => this.parse(contents),
      emptyValue: () => [],
      isUnsupportedSchemaError: (error) => error instanceof UnsupportedAgencyLayoutSchemaError,
      recoveryErrorMessage: 'Agency layout store could not be recovered',
    });
    return result.value;
  }

  private parse(contents: string): WorkspacePaneLayout[] {
    const raw: unknown = JSON.parse(contents);
    if (!isRecord(raw)) {
      throw new Error('Invalid Agency layout store: expected object');
    }
    if (!Number.isInteger(raw.version)) throw new Error('Invalid Agency layout store version');
    if (raw.version !== VERSION) {
      throw new UnsupportedAgencyLayoutSchemaError(raw.version);
    }
    if (!Array.isArray(raw.layouts)) {
      throw new Error('Invalid Agency layout store: layouts must be an array');
    }
    const valid: WorkspacePaneLayout[] = [];
    const seen = new Set<WorkspaceId>();
    for (const item of raw.layouts) {
      // Skipping malformed entries silently loses panes and can prevent backup
      // recovery. Treat the primary as corrupt and restore its valid backup.
      if (!isWorkspacePaneLayout(item)) throw new Error('Invalid Agency layout record');
      if (seen.has(item.workspaceId)) throw new Error('Duplicate Agency layout workspace');
      seen.add(item.workspaceId);
      valid.push(item);
    }
    return valid;
  }

  /**
   * Write `layouts` without publishing them into memory first.
   * A rejected write leaves the queue usable so the next save can persist.
   */
  private persist(layouts: Iterable<WorkspacePaneLayout>): Promise<void> {
    const payload = JSON.stringify({
      version: VERSION,
      layouts: [...layouts],
    }, null, 2);

    return this.writeQueue.run(() =>
      writeSnapshotWithBackup({
        filePath: this.file,
        content: payload,
        fileMode: 0o600,
        write: this.write,
      }),
    );
  }

  get(workspaceId: WorkspaceId): WorkspacePaneLayout | undefined {
    return this.layouts.get(workspaceId);
  }

  list(): WorkspacePaneLayout[] {
    return [...this.layouts.values()];
  }

  async save(layout: WorkspacePaneLayout): Promise<void> {
    if (!isWorkspacePaneLayout(layout)) {
      throw new Error('Invalid WorkspacePaneLayout payload');
    }
    return this.mutationQueue.run(async () => {
      const next = new Map(this.layouts);
      next.set(layout.workspaceId, layout);
      await this.persist(next.values());
      this.layouts.set(layout.workspaceId, layout);
    });
  }

  /** Read and change the latest layout within the persistence queue. */
  async update(
    workspaceId: WorkspaceId,
    change: (current: WorkspacePaneLayout | undefined) => WorkspacePaneLayout,
  ): Promise<WorkspacePaneLayout> {
    return this.mutationQueue.run(async () => {
      const layout = change(this.layouts.get(workspaceId));
      if (layout.workspaceId !== workspaceId || !isWorkspacePaneLayout(layout)) {
        throw new Error('Invalid layout update');
      }
      const next = new Map(this.layouts);
      next.set(workspaceId, layout);
      await this.persist(next.values());
      this.layouts.set(workspaceId, layout);
      return layout;
    });
  }

  async delete(workspaceId: WorkspaceId): Promise<void> {
    return this.mutationQueue.run(async () => {
      if (!this.layouts.has(workspaceId)) return;
      const next = new Map(this.layouts);
      next.delete(workspaceId);
      await this.persist(next.values());
      this.layouts.delete(workspaceId);
    });
  }

  flush(): Promise<void> {
    return this.mutationQueue.flush().then(() => this.writeQueue.flush());
  }
}
