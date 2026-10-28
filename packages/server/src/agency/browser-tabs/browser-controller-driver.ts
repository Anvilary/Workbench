/**
 * Driver interface for the underlying browser engine (e.g. Neko Chromium controller).
 *
 * Keeps the durable tab domain decoupled from Neko internals.
 * Lane A implements this interface to reconcile live Chromium targets and manage page lifecycles.
 */

export interface OpenTargetResult {
  targetRef: string;
}

export interface TargetMetadata {
  /** Stable MAW tab ID. */
  tabId: string;
  /** Owning Agency workspace ID. */
  workspaceId: string;
  /** Conversation URL. */
  url?: string;
}

export interface TargetInfo {
  targetRef: string;
  tabId?: string;
  workspaceId?: string;
  url?: string;
  alive: boolean;
  active: boolean;
}

export interface BrowserControllerDriver {
  /**
   * Request that the browser engine open a new Chromium page/target at the specified URL
   * tagged with MAW tab ownership metadata.
   * Returns the browser engine's runtime target reference.
   */
  openTarget(url: string, metadata?: TargetMetadata): Promise<OpenTargetResult>;

  /**
   * Request that the browser engine display/focus an already-loaded target.
   * Switching targets must NEVER close or navigate away previously loaded targets.
   */
  activateTarget(targetRef: string): Promise<void>;

  /**
   * Request that an existing target navigate to a new URL.
   */
  navigateTarget(targetRef: string, url: string): Promise<void>;

  /**
   * Request that the browser engine close a target.
   */
  closeTarget(targetRef: string): Promise<void>;

  /**
   * Inquire whether a target reference is still open/alive in the browser engine.
   */
  isTargetAlive(targetRef: string): Promise<boolean>;

  /**
   * Verify whether an existing browser target strictly matches the expected tab ownership.
   * Returns true only when tabId and workspaceId match.
   * Never blindly matches based on URL or title alone.
   */
  verifyTargetOwnership(targetRef: string, expected: TargetMetadata): Promise<boolean>;

  /** Observe the current page address through trusted target inventory only. */
  getTargetUrl?(targetRef: string): Promise<string | null>;

  /** Resolve a durable controller receipt after a create response was lost. */
  findOwnedTarget?(expected: TargetMetadata): Promise<string | null>;

  /**
   * Inquire active ongoing background operations (e.g. assistant streaming response).
   */
  hasOngoingOperation?(targetRef: string): Promise<boolean>;
}

export class BrowserEngineUnavailableError extends Error {
  constructor(message = 'Browser engine is unavailable or unconfigured') {
    super(message);
    this.name = 'BrowserEngineUnavailableError';
  }
}

/**
 * Null driver representing an unconfigured or offline Neko browser engine.
 * Explicitly fails browser operations with a typed error rather than inventing fictional targets.
 */
export class NullBrowserControllerDriver implements BrowserControllerDriver {
  async openTarget(_url: string, _metadata?: TargetMetadata): Promise<OpenTargetResult> {
    throw new BrowserEngineUnavailableError('Browser engine is not configured or unavailable');
  }

  async activateTarget(_targetRef: string): Promise<void> {
    throw new BrowserEngineUnavailableError('Browser engine is not configured or unavailable');
  }

  async navigateTarget(_targetRef: string, _url: string): Promise<void> {
    throw new BrowserEngineUnavailableError('Browser engine is not configured or unavailable');
  }

  async closeTarget(_targetRef: string): Promise<void> {
    throw new BrowserEngineUnavailableError('Browser engine is not configured or unavailable');
  }

  async isTargetAlive(_targetRef: string): Promise<boolean> {
    throw new BrowserEngineUnavailableError();
  }

  async verifyTargetOwnership(_targetRef: string, _expected: TargetMetadata): Promise<boolean> {
    throw new BrowserEngineUnavailableError();
  }
}

/**
 * In-memory driver for deterministic testing, reconciliation, and headless verification.
 */
export class MemoryBrowserControllerDriver implements BrowserControllerDriver {
  private counter = 0;
  readonly targets = new Map<
    string,
    {
      url: string;
      active: boolean;
      closed: boolean;
      metadata?: TargetMetadata;
      ongoingOperation?: string;
    }
  >();
  readonly callLog: Array<{ method: string; args: unknown[] }> = [];
  /** Target refs configured to fail destruction during closeTarget */
  readonly failCloseTargets = new Set<string>();
  /** Target refs configured to fail activation during activateTarget */
  readonly failActivateTargets = new Set<string>();

  async openTarget(url: string, metadata?: TargetMetadata): Promise<OpenTargetResult> {
    this.callLog.push({ method: 'openTarget', args: [url, metadata] });
    const targetRef = `mem-target-${++this.counter}`;
    this.targets.set(targetRef, {
      url,
      active: true,
      closed: false,
      metadata,
    });
    return { targetRef };
  }

  async activateTarget(targetRef: string): Promise<void> {
    this.callLog.push({ method: 'activateTarget', args: [targetRef] });
    if (this.failActivateTargets.has(targetRef)) {
      throw new Error(`Simulated failure activating target ${targetRef}`);
    }
    const target = this.targets.get(targetRef);
    if (!target || target.closed) {
      throw new Error(`Target ${targetRef} not found or already closed`);
    }
    for (const [id, t] of this.targets.entries()) {
      t.active = id === targetRef;
    }
  }

  async navigateTarget(targetRef: string, url: string): Promise<void> {
    this.callLog.push({ method: 'navigateTarget', args: [targetRef, url] });
    const target = this.targets.get(targetRef);
    if (!target || target.closed) {
      throw new Error(`Target ${targetRef} not found or already closed`);
    }
    target.url = url;
  }

  async closeTarget(targetRef: string): Promise<void> {
    this.callLog.push({ method: 'closeTarget', args: [targetRef] });
    if (this.failCloseTargets.has(targetRef)) {
      throw new Error(`Simulated CDP failure closing target ${targetRef}`);
    }
    const target = this.targets.get(targetRef);
    if (target) {
      target.closed = true;
      target.active = false;
      target.ongoingOperation = undefined;
    }
  }

  async isTargetAlive(targetRef: string): Promise<boolean> {
    const target = this.targets.get(targetRef);
    return !!target && !target.closed;
  }

  async verifyTargetOwnership(targetRef: string, expected: TargetMetadata): Promise<boolean> {
    const target = this.targets.get(targetRef);
    if (!target || target.closed) return false;
    if (!target.metadata) return false;
    // Strict ownership verification: requires matching tabId and workspaceId
    return (
      target.metadata.tabId === expected.tabId &&
      target.metadata.workspaceId === expected.workspaceId
    );
  }

  setOngoingOperation(targetRef: string, operationDescription: string): void {
    const target = this.targets.get(targetRef);
    if (target) {
      target.ongoingOperation = operationDescription;
    }
  }

  async hasOngoingOperation(targetRef: string): Promise<boolean> {
    const target = this.targets.get(targetRef);
    return !!target && !target.closed && target.ongoingOperation !== undefined;
  }

  getActiveTarget(): string | null {
    for (const [id, t] of this.targets.entries()) {
      if (t.active && !t.closed) return id;
    }
    return null;
  }

  getTargetCount(): number {
    return Array.from(this.targets.values()).filter((t) => !t.closed).length;
  }
}
