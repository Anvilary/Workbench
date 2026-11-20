/**
 * Clipboard commands of the desktop shell: copying a file for the file manager and
 * reading or writing text.
 */

import { fileClipboardPayload, resolveClipboardTarget } from './file-clipboard.mjs';

export function createClipboardCommands({ clipboard, ClipboardItem }) {
  async function copyFile(command) {
    const resolved = await resolveClipboardTarget(command.cwd, command.relative, { requireAuthoritative: true });
    if (!resolved.ok) return { ok: false, error: resolved.error };
    try {
      const payload = fileClipboardPayload(resolved.absolute);
      if (typeof ClipboardItem !== 'undefined' && typeof clipboard.write === 'function') {
        const item = new ClipboardItem({
          'text/uri-list': new Blob([payload.uriList], { type: 'text/uri-list' }),
          'x-special/gnome-copied-files': new Blob([payload.gnome], { type: 'x-special/gnome-copied-files' }),
        });
        await clipboard.write([item]);
      } else if (typeof clipboard.writeBuffer === 'function') {
        clipboard.writeBuffer('text/uri-list', payload.uriList);
        clipboard.writeBuffer('x-special/gnome-copied-files', payload.gnome);
      }
      return { ok: true, directory: resolved.directory };
    } catch (err) {
      console.error('[desktop] copy-file error:', err);
      return { ok: false, error: 'unavailable' };
    }
  }

  async function writeText(command) {
    try {
      await clipboard.writeText(command.text);
      return { ok: true };
    } catch (err) {
      console.error('[desktop] write-clipboard-text error:', err);
      return { ok: false, error: 'unavailable' };
    }
  }

  async function readText() {
    try {
      const text = await clipboard.readText();
      return { ok: true, text: typeof text === 'string' ? text : '' };
    } catch (err) {
      console.error('[desktop] read-clipboard-text error:', err);
      return { ok: false, error: 'unavailable' };
    }
  }

  return { copyFile, writeText, readText };
}
