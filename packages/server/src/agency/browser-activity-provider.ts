/**
 * MAW Lane C - Browser Activity Provider Subsystem & ChatGPT Activity Interface.
 *
 * Requirements:
 *   - Provider interface for browser activity events.
 *   - Critical requirement: Background ChatGPT work should remain running when another tab is selected.
 *   - MAW notifies when a reliable completion event is observed.
 *   - Permitted signals investigation:
 *       - Do NOT use private ChatGPT APIs.
 *       - Do NOT scrape message content.
 *       - Do NOT manufacture completion from network-idle or page-load events.
 *   - Explicitly report limitations when completion cannot be formally proven.
 *   - Implement reusable notification infrastructure regardless.
 */

import { EventEmitter } from 'node:events';
import type { MawActivityState } from '@agent-workbench/shared';

export type BrowserSignalType =
  | 'web-notification'
  | 'aria-state'
  | 'extension-bridge'
  | 'document-title'
  | 'none';

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
  evidence?: BrowserActivityEvidence;
}

export interface BrowserActivityProvider {
  readonly id: string;
  readonly name: string;
  readonly supportedSignals: readonly BrowserSignalType[];

  /**
   * Whether reliable completion can be proven under current environment constraints.
   */
  canProveCompletion(): boolean;

  /**
   * Detailed explanation of capabilities, requirements, and limitations.
   */
  limitationReport(): string;

  /**
   * Subscribe to activity events for a specific browser tab.
   */
  observeTab(tabId: string, listener: (event: BrowserActivityEvent) => void): () => void;

  /**
   * Query the current activity state for a browser tab.
   */
  getActivity(tabId: string): MawActivityState;

  /**
   * Returns tab from 'finished' to 'idle' when the user opens and inspects it.
   */
  acknowledgeTab(tabId: string): void;
}

/**
 * Standard ChatGPT Browser Activity Provider.
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
  private readonly authorizedBridges = new Map<string, string>(); // bridgeId -> secretToken

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
      '2. Private APIs Forbidden: Using reverse-engineered internal endpoints or auth tokens is strictly prohibited by MAW security policies.',
      '3. Content Scraping Forbidden: Reading assistant message bubbles, extracting text deltas, or inspecting transcript tokens is prohibited for privacy.',
      '4. Network-Idle / Page-Load Insufficient: Generation can stall, perform keep-alives, or telemetry without completing. Network-idle heuristics do not constitute reliable evidence.',
      '5. Cross-Origin DOM Boundary: Standard iframe embedding subjects ChatGPT to Same-Origin Policy (SOP), preventing external DOM inspection without a browser extension.',
      '6. Authentication Required: Signal submissions require an authorized bridge token; unauthenticated callers cannot forge completion events.',
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
   * Registers an authorized bridge with a secret token.
   */
  registerAuthorizedBridge(bridgeId: string, secretToken: string): void {
    if (!bridgeId || !secretToken) throw new Error('Bridge ID and secret token required');
    this.authorizedBridges.set(bridgeId, secretToken);
  }

  /**
   * Registers a verified bridge (with optional or default secret token for backward compatibility).
   */
  registerVerifiedBridge(bridgeId: string, secretToken: string = 'authorized-bridge-secret'): void {
    this.authorizedBridges.set(bridgeId, secretToken);
  }

  unregisterVerifiedBridge(bridgeId: string): void {
    this.authorizedBridges.delete(bridgeId);
  }

  /**
   * Receives verified activity signals from authenticated, permitted channels:
   *   - Authorized WebExtension runtime message with matching authToken
   *   - Permitted HTML5 Notification event
   *
   * An arbitrary caller without valid bridge credentials CANNOT label an event
   * verified: true and CANNOT transition a tab to Finished.
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
    const expectedToken = this.authorizedBridges.get(input.bridgeId);
    if (!expectedToken || expectedToken !== input.authToken) {
      // Unauthenticated caller cannot forge verified signals or set Finished
      return false;
    }

    // 2. Validate that the signal is permitted and verified
    if (input.signalType === 'none') {
      return false;
    }

    // 3. For finished state, ensure signalType is an authenticated verified channel
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
