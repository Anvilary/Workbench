import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import type { MawActivityState } from '@anvilary/workbench-shared';

export type BrowserSignalType =
  | 'none'
  | 'extension-bridge'
  | 'web-notification'
  | 'aria-state';

export interface BrowserActivityEvidence {
  signalType: BrowserSignalType;
  verified: boolean;
  timestamp: number;
  rawSignal?: string;
  notes?: string;
}

export interface BrowserActivityEvent {
  tabId: string;
  providerId: string;
  state: MawActivityState;
  detail?: string;
  evidence: BrowserActivityEvidence;
}

export interface AuthorizedBridgeRegistration {
  bridgeId: string;
  secretToken: string;
  allowedTabIds: readonly string[];
  createdAt: number;
}

/**
 * Generates an explicit, strong, cryptographically secure 256-bit bridge token.
 */
export function generateStrongBridgeToken(): string {
  return randomBytes(32).toString('hex');
}

export interface BrowserActivityProvider extends EventEmitter {
  readonly id: string;
  readonly name: string;
  readonly supportedSignals: readonly BrowserSignalType[];

  /**
   * Subscribe to activity events for a specific browser tab.
   */
  observeTab(tabId: string, listener: (event: BrowserActivityEvent) => void): () => void;

  /**
   * Query the current activity state for a browser tab.
   */
  getActivity(tabId: string): MawActivityState;

  /**
   * Resets tab activity state to 'idle' upon user inspection.
   */
  acknowledgeTab(tabId: string): void;

  /**
   * Evaluates whether a completion signal can be reliably and legally proven.
   */
  canProveCompletion(): boolean;

  /**
   * Reports factual evidence limitations.
   */
  limitationReport(): string;

  dispose(): void;
}

/**
 * ChatGPT Web Tab Activity Provider.
 *
 * Implements the provider interface while truthfully reporting evidence limitations.
 */
export class ChatGPTActivityProvider extends EventEmitter implements BrowserActivityProvider {
  readonly id = 'chatgpt-web';
  readonly name = 'ChatGPT (Web)';
  readonly supportedSignals: readonly BrowserSignalType[] = [
    'extension-bridge',
    'web-notification',
    'aria-state',
  ];

  private readonly tabStates = new Map<string, MawActivityState>();
  private readonly tabListeners = new Map<string, Set<(event: BrowserActivityEvent) => void>>();
  private readonly authorizedBridges = new Map<string, AuthorizedBridgeRegistration>();

  constructor() {
    super();
  }

  /**
   * Formally evaluates whether completion can be proven without violating
   * privacy and API restrictions.
   */
  canProveCompletion(): boolean {
    // Only proven when an authenticated extension bridge is active
    return this.authorizedBridges.size > 0;
  }

  limitationReport(): string {
    return [
      'ChatGPT Web Activity & Completion Detection Limitations:',
      '1. No Public Webhook / Completion API: OpenAI does not publish an external, versioned JavaScript SDK or postMessage protocol for web chat completion.',
      '2. Private APIs Forbidden: Using reverse-engineered internal endpoints or auth tokens is strictly prohibited by Workbench security policies.',
      '3. Content Scraping Forbidden: Reading assistant message bubbles, extracting text deltas, or inspecting transcript tokens is prohibited for privacy.',
      '4. Network-Idle / Page-Load Insufficient: Generation can stall, perform keep-alives, or telemetry without completing. Network-idle heuristics do not constitute reliable evidence.',
      '5. Cross-Origin DOM Boundary: Standard iframe embedding subjects ChatGPT to Same-Origin Policy (SOP), preventing external DOM inspection without a browser extension.',
      '6. Authentication & Target-Binding Required: Signal submissions require an explicit strong token and are bound strictly to authorized tab IDs; arbitrary callers cannot forge events.',
      '7. Security Notice: Token authentication alone verifies caller credentials and target binding, but does not independently verify the factual accuracy of a third-party webpage state without permitted browser-platform signals.',
      'Conclusion: In the absence of an authenticated, verified WebExtension companion bridge or user-authorized Notification permission bridge, ChatGPT tab activity is truthfully reported as "unknown".',
    ].join('\n');
  }

  observeTab(tabId: string, listener: (event: BrowserActivityEvent) => void): () => void {
    let listeners = this.tabListeners.get(tabId);
    if (!listeners) {
      listeners = new Set();
      this.tabListeners.set(tabId, listeners);
    }
    listeners.add(listener);

    return () => {
      listeners?.delete(listener);
      if (listeners && listeners.size === 0) {
        this.tabListeners.delete(tabId);
      }
    };
  }

  getActivity(tabId: string): MawActivityState {
    return this.tabStates.get(tabId) ?? 'unknown';
  }

  acknowledgeTab(tabId: string): void {
    if (this.tabStates.get(tabId) === 'finished') {
      this.tabStates.set(tabId, 'idle');
      this.emitTabEvent({
        tabId,
        providerId: this.id,
        state: 'idle',
        detail: 'acknowledged-by-inspection',
        evidence: {
          signalType: 'none',
          verified: true,
          timestamp: Date.now(),
          notes: 'User opened and inspected tab result',
        },
      });
    }
  }

  /**
   * Registers an authorized bridge with an explicit strong secret token and bound allowed tab IDs.
   * Predictable default credentials are eliminated.
   */
  registerAuthorizedBridge(bridgeId: string, secretToken: string, allowedTabIds: readonly string[]): void {
    if (!bridgeId || bridgeId.trim().length === 0) throw new Error('Bridge ID is required');
    if (!secretToken || secretToken.length < 16) throw new Error('Explicit strong secretToken (minimum 16 characters) is required');
    if (!allowedTabIds || allowedTabIds.length === 0) throw new Error('Bridge authorization must be bound to explicit allowedTabIds');

    this.authorizedBridges.set(bridgeId, {
      bridgeId,
      secretToken,
      allowedTabIds: [...allowedTabIds],
      createdAt: Date.now(),
    });
  }

  /**
   * Registers a verified bridge requiring explicit strong token and tab-binding.
   */
  registerVerifiedBridge(bridgeId: string, secretToken: string, allowedTabIds: readonly string[]): void {
    this.registerAuthorizedBridge(bridgeId, secretToken, allowedTabIds);
  }

  unregisterVerifiedBridge(bridgeId: string): void {
    this.authorizedBridges.delete(bridgeId);
  }

  /**
   * Receives verified activity signals from authenticated, permitted channels:
   *   - Authorized WebExtension runtime message with matching authToken and target tab binding
   *   - Permitted HTML5 Notification event
   *
   * An arbitrary caller without valid bridge credentials CANNOT label an event
   * verified: true, CANNOT submit events for unrelated tabs, and CANNOT transition a tab to Finished.
   */
  reportVerifiedSignal(input: {
    tabId: string;
    bridgeId?: string;
    authToken?: string;
    signalType: BrowserSignalType;
    state: MawActivityState;
    rawSignal?: string;
    notes?: string;
  }): boolean {
    // 1. Authenticate caller: must present a valid registered bridgeId and authToken
    if (!input.bridgeId || !input.authToken) {
      return false;
    }
    const registration = this.authorizedBridges.get(input.bridgeId);
    if (!registration || registration.secretToken !== input.authToken) {
      // Unauthenticated caller cannot forge verified signals or set Finished
      return false;
    }

    // 2. Reject attempts to submit events for unrelated tabs (target binding)
    if (!registration.allowedTabIds.includes(input.tabId)) {
      return false;
    }

    // 3. Validate that the signal is permitted and verified
    if (input.signalType === 'none') {
      return false;
    }

    // 4. For finished state, ensure signalType is an authenticated verified channel
    if (input.state === 'finished' && input.signalType !== 'extension-bridge' && input.signalType !== 'web-notification') {
      return false;
    }

    const previous = this.tabStates.get(input.tabId);
    // If already finished and not acknowledged, preserve 'finished' state
    if (previous === 'finished' && input.state !== 'idle') {
      return false;
    }

    this.tabStates.set(input.tabId, input.state);

    this.emitTabEvent({
      tabId: input.tabId,
      providerId: this.id,
      state: input.state,
      detail: `verified-${input.signalType}`,
      evidence: {
        signalType: input.signalType,
        verified: true,
        timestamp: Date.now(),
        rawSignal: input.rawSignal,
        notes: input.notes,
      },
    });

    return true;
  }

  private emitTabEvent(event: BrowserActivityEvent): void {
    const listeners = this.tabListeners.get(event.tabId);
    if (listeners) {
      for (const listener of listeners) {
        try {
          listener(event);
        } catch (err) {
          console.warn('[chatgpt-provider] listener error: ' + String(err));
        }
      }
    }
    this.emit('activity', event);
  }

  dispose(): void {
    this.tabStates.clear();
    this.tabListeners.clear();
    this.authorizedBridges.clear();
    this.removeAllListeners();
  }
}
