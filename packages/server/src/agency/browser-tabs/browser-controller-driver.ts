/**
 * Driver interface for the underlying browser engine (e.g. Neko Chromium controller).
 *
 * Keeps the durable tab domain decoupled from Neko internals.
 * Lane A can implement this interface once the control transport is confirmed.
 */

export interface OpenTargetResult {
  targetRef: string;
}

export interface BrowserControllerDriver {
  /**
   * Request that the browser engine open a new Chromium page/target at the specified URL.
   * Returns the browser engine's runtime target reference.
   */
  openTarget(url: string): Promise<OpenTargetResult>;

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
}

/**
 * Safe null driver used when Neko browser engine is unconfigured or offline.
 */
export class NullBrowserControllerDriver implements BrowserControllerDriver {
  async openTarget(_url: string): Promise<OpenTargetResult> {
    return { targetRef: 'null-target' };
  }

  async activateTarget(_targetRef: string): Promise<void> {}

  async navigateTarget(_targetRef: string, _url: string): Promise<void> {}

  async closeTarget(_targetRef: string): Promise<void> {}

  async isTargetAlive(_targetRef: string): Promise<boolean> {
    return false;
  }
}

/**
 * In-memory driver for deterministic testing and headless verification.
 */
export class MemoryBrowserControllerDriver implements BrowserControllerDriver {
  private counter = 0;
  readonly targets = new Map<string, { url: string; active: boolean; closed: boolean }>();
  readonly callLog: Array<{ method: string; args: unknown[] }> = [];

  async openTarget(url: string): Promise<OpenTargetResult> {
    this.callLog.push({ method: 'openTarget', args: [url] });
    const targetRef = `mem-target-${++this.counter}`;
    this.targets.set(targetRef, { url, active: true, closed: false });
    return { targetRef };
  }

  async activateTarget(targetRef: string): Promise<void> {
    this.callLog.push({ method: 'activateTarget', args: [targetRef] });
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
    const target = this.targets.get(targetRef);
    if (target) {
      target.closed = true;
      target.active = false;
    }
  }

  async isTargetAlive(targetRef: string): Promise<boolean> {
    const target = this.targets.get(targetRef);
    return !!target && !target.closed;
  }

  getActiveTarget(): string | null {
    for (const [id, t] of this.targets.entries()) {
      if (t.active && !t.closed) return id;
    }
    return null;
  }
}
