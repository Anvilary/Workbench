/**
 * Keyboard-input ownership for a terminal view.
 *
 * xterm turns three kinds of events into `onData`:
 *  - user input (keys, IME composition, paste) on its hidden textarea,
 *  - terminal protocol replies (cursor position, device attributes, focus and mouse reports),
 *  - programmatic `terminal.input(...)`.
 *
 * Only the first kind is the user's keyboard. It must reach the PTY only when this
 * terminal is the one that owns the keyboard: its tab is active, its textarea is the
 * focused element, and the shell document itself has window focus (a native browser view
 * such as ChatGPT holds focus in another renderer, so the shell document does not).
 * Protocol replies and programmatic input are not keyboard input and are never blocked here:
 * background CLIs rely on those replies.
 */

/** Events on the xterm textarea that can produce user-keyboard `onData`. */
export const KEYBOARD_GESTURE_EVENTS = [
  'keydown',
  'keypress',
  'beforeinput',
  'input',
  'compositionstart',
  'compositionupdate',
  'compositionend',
  'paste',
] as const;

/**
 * xterm emits composition text from a zero-delay timeout after `compositionend`, so a
 * keyboard-origin `onData` can trail its gesture by a few milliseconds. Anything inside
 * this window after a keyboard gesture on the textarea is treated as keyboard-origin.
 */
export const KEYBOARD_GESTURE_WINDOW_MS = 100;

export interface KeyboardOwnership {
  /** The tab hosting this terminal is the selected one in a visible pane. */
  active: boolean;
  /** `document.activeElement` is this terminal's xterm textarea. */
  textareaFocused: boolean;
  /** The shell document has window focus (false while a native view or another app owns it). */
  documentFocused: boolean;
}

export function ownsKeyboard(state: KeyboardOwnership): boolean {
  return state.active && state.textareaFocused && state.documentFocused;
}

/** True when `onData` at `now` follows a keyboard gesture on this terminal's textarea. */
export function isKeyboardOrigin(lastGestureAt: number | null, now: number): boolean {
  return lastGestureAt !== null && now - lastGestureAt >= 0 && now - lastGestureAt <= KEYBOARD_GESTURE_WINDOW_MS;
}

/**
 * Decide whether an `onData` payload may be forwarded to the PTY.
 * Keyboard-origin data needs ownership; everything else passes.
 */
export function shouldForwardTerminalData(input: {
  lastGestureAt: number | null;
  now: number;
  ownership: KeyboardOwnership;
}): boolean {
  if (!isKeyboardOrigin(input.lastGestureAt, input.now)) return true;
  return ownsKeyboard(input.ownership);
}

/** Pointer-driven alternate-screen scrolling is also terminal input: only the active tab may send it. */
export function shouldForwardWheelInput(active: boolean): boolean {
  return active;
}

export function documentHasWindowFocus(doc: Pick<Document, 'hasFocus'> | undefined): boolean {
  if (doc === undefined || typeof doc.hasFocus !== 'function') return true;
  return doc.hasFocus();
}
