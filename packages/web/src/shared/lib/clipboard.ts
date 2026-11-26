/**
 * Unified clipboard bridge for Workbench.
 *
 * In local Electron desktop runtime, delegates text operations to Electron's
 * native clipboard via `workbench.command`, bypassing Chromium document focus
 * restrictions and sandbox permission hurdles.
 *
 * In browser-only or remote client environments, transparently falls back to
 * `navigator.clipboard`.
 */

export async function writeClipboard(text: string, isRemoteClient = false): Promise<boolean> {
  if (typeof text !== 'string') return false;

  // 1. Local Electron desktop bridge
  if (
    !isRemoteClient &&
    typeof window !== 'undefined' &&
    window.workbench?.command
  ) {
    try {
      const res = (await window.workbench.command({
        type: 'write-clipboard-text',
        text,
      })) as { ok?: boolean; error?: string } | undefined;
      if (res && res.ok) {
        return true;
      }
    } catch {
      // Fall through to browser clipboard API if desktop IPC failed
    }
  }

  // 2. Standard Browser Clipboard API fallback
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }

  return false;
}

export async function readClipboard(isRemoteClient = false): Promise<string | null> {
  // 1. Local Electron desktop bridge
  if (
    !isRemoteClient &&
    typeof window !== 'undefined' &&
    window.workbench?.command
  ) {
    try {
      const res = (await window.workbench.command({
        type: 'read-clipboard-text',
      })) as { ok?: boolean; text?: string; error?: string } | undefined;
      if (res && res.ok && typeof res.text === 'string') {
        return res.text;
      }
    } catch {
      // Fall through
    }
  }

  // 2. Standard Browser Clipboard API fallback
  if (typeof navigator !== 'undefined' && navigator.clipboard?.readText) {
    try {
      return await navigator.clipboard.readText();
    } catch {
      return null;
    }
  }

  return null;
}
