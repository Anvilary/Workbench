/**
 * The privileged IPC command channel between the shell page and the main process.
 *
 * Every request is validated once here: the sender must be the shell page on the
 * current backend origin and the command must be a known one. Handlers then call
 * the owner of the resource the command touches (the BrowserViewController, the
 * performance channel, the clipboard commands). No handler trusts a renderer
 * beyond what validation established.
 */

import { CHANNEL, trustedSender, validCommand } from '../../policy.mjs';

export function registerCommandRouter({ ipcMain, win, dialog, backend, controller, performance, hardwareAcceleration, clipboardCommands }) {
  const handlers = {
    'restore-shell-storage': async () => {
      const storage = backend.takePendingShellStorage();
      return { ...storage, browserTabs: controller.shellBrowserTabs() };
    },
    'get-favicons': async () => ({ ok: true, favicons: controller.favicons() }),
    'browse-executable': async (command) => {
    const result = await dialog.showOpenDialog(win, {
      title: (typeof command.title === 'string' && command.title) ? command.title : 'Select CLI Executable',
      properties: ['openFile'],
      filters: process.platform === 'win32'
        ? [{ name: 'Executables', extensions: ['exe', 'cmd', 'bat', 'ps1', '*'] }]
        : undefined,
    });
    if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
      return { ok: true, path: null };
    }
    return { ok: true, path: result.filePaths[0] };
    },
    'get-backend-endpoint': async () => {
    try {
      const found = await backend.readiness();
      return {
        ok: true,
        url: found.url.href,
        origin: found.url.origin,
        token: found.url.searchParams.get('token'),
        port: found.url.port,
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
    },
    'performance-subscribe': () => performance.subscribe(),
    'performance-unsubscribe': () => performance.unsubscribe(),
    'performance-pause': () => performance.pause(),
    'performance-resume': () => performance.resume(),
    'performance-refresh': () => performance.refresh(),
    'get-hardware-acceleration': async () => hardwareAcceleration.status(),
    'set-hardware-acceleration': async (command) => hardwareAcceleration.set(command.enabled),
    'open': async (command) => { controller.open(command); },
    'update': async (command) => { controller.update(command); },
    'clone-profile': (command) => controller.cloneProfile(command),
    'clear-profile-site-auth': (command) => controller.clearProfileSite(command),
    'delete-profile': (command) => controller.deleteProfile(command),
    'browser-action': async (command) => { controller.browserAction(command); },
    'find-in-page': async (command) => controller.findInPage(command),
    'stop-find-in-page': async (command) => controller.stopFindInPage(command),
    'copy-file': (command) => clipboardCommands.copyFile(command),
    'write-clipboard-text': (command) => clipboardCommands.writeText(command),
    'read-clipboard-text': () => clipboardCommands.readText(),
    'close': async (command) => { controller.close(command); },
    'retain': async (command) => { controller.retain(command); },
    'capture': (command) => controller.capture(command),
    'layout': async (command) => { controller.applyLayout(command); },
    'inspect-page': async (command) => controller.inspectPage(command),
    'get-available-spellcheck-languages': async () => ({
      ok: true,
      languages: controller.getAvailableSpellCheckerLanguages(),
    }),
    'get-spellcheck-status': async () => ({
      ok: true,
      ...controller.getSpellCheckStatus(),
    }),
    'update-spellcheck-settings': async (command) => controller.applySpellCheckSettings(command),
    'list-custom-dictionary-words': async (command) => controller.listCustomDictionaryWords(command.profileId),
    'add-custom-dictionary-word': async (command) => controller.addCustomDictionaryWord(command.word, command.profileId),
    'remove-custom-dictionary-word': async (command) => controller.removeCustomDictionaryWord(command.word, command.profileId),
    'reconcile-custom-dictionary': async (command) => controller.reconcileCustomDictionary(command.customWordsByProfile),
  };

  ipcMain.handle(CHANNEL, async (event, command) => {
    if (!trustedSender(event, win.webContents, backend.current().origin) || !validCommand(command, { backendPort: backend.current().port })) throw new Error('Invalid desktop request');
    if (!Object.hasOwn(handlers, command.type)) return undefined;
    return handlers[command.type](command);
  });
}
