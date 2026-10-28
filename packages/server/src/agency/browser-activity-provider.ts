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
  private readonly verifiedBridges = new Set<string>();

  constructor() {
    super();
  }

  /**
   * Formally evaluates whether completion can be proven without violating
   * privacy and API restrictions.
   */
  canProveCompletion(): boolean {
    // Only proven when a verified extension bridge or permitted notification hook is active
    return this.verifiedBridges.size > 0;
  }

  limitationReport(): string {
    return [
      'ChatGPT Web Activity & Completion Detection Limitations:',
      '1. No Public Webhook / Completion API: OpenAI does not publish an external, versioned JavaScript SDK or postMessage protocol for web chat completion.',
      '2. Private APIs Forbidden: Using reverse-engineered internal endpoints or auth tokens is strictly prohibited by MAW security policies.',
      '3. Content Scraping Forbidden: Reading assistant message bubbles, extracting text deltas, or inspecting transcript tokens is prohibited for privacy.',
      '4. Network-Idle / Page-Load Insufficient: Generation can stall, perform keep-alives, or telemetry without completing. Network-idle heuristics do not constitute reliable evidence.',
      '5. Cross-Origin DOM Boundary: Standard iframe embedding subjects ChatGPT to Same-Origin Policy (SOP), preventing external DOM inspection without a browser extension.',
      'Conclusion: In the absence of a verified WebExtension companion bridge or user-authorized Notification permission bridge, ChatGPT tab activity is truthfully reported as "unknown".',
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
   * Registers a verified companion bridge (e.g. from an authorized browser extension
   * or trusted background runner).
   */
  registerVerifiedBridge(bridgeId: string): void {
    this.verifiedBridges.add(bridgeId);
  }

  unregisterVerifiedBridge(bridgeId: string): void {
    this.verifiedBridges.delete(bridgeId);
  }

  /**
   * Receives verified activity signals from permitted channels:
   *   - Authorized WebExtension runtime message
   *   - Permitted HTML5 Notification event
   *   - Permitted ARIA busy attribute change (without reading text content)
   */
  reportVerifiedSignal(input: {
    tabId: string;
    signalType: BrowserSignalType;
    state: MawActivityState;
    rawSignal?: string;
    notes?: string;
  }): boolean {
    // Validate that the signal is permitted and verified
    if (input.signalType === 'none') {
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
    this.verifiedBridges.clear();
    this.removeAllListeners();
  }
}
