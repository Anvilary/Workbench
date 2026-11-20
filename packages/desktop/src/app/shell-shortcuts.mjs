/**
 * Keyboard shortcuts handled by the desktop shell itself.
 */

export function createDesktopShortcut({ win, send }) {
  function desktopShortcut(event, input) {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F11') { event.preventDefault(); win.setFullScreen(!win.isFullScreen()); }
    if (input.control && (input.key === 'Tab' || input.key === 'PageUp' || input.key === 'PageDown')) {
      event.preventDefault(); send({ type: 'tab-shortcut', direction: input.shift || input.key === 'PageUp' ? -1 : 1 });
    }
    if (input.control && input.key.toLowerCase() === 'w') { event.preventDefault(); send({ type: 'close-shortcut' }); }
  }
  return desktopShortcut;
}
