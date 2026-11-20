# ChatGPT tab integration

The desktop-first MAW app reuses the React frontend and the existing Node/PTY
service. The tab strip uses the existing server UUIDs, order and single selection
across CLI, terminal and web tabs. The server owns logical web metadata only.
Native pages and shared authentication belong to the Electron process.

`NativeChatGptView` measures MAW's own pane and reports its clipped bounds through
a sender-validated preload bridge. It never reads the website DOM. MAW overlays
and pointer drags detach the native view; selecting a different tab keeps the old
page alive. Closing a logical web tab prunes its native view. Reconnecting preserves
the last durable URL, and Chromium navigation events checkpoint subsequent URLs.

The ordinary browser UI is a secondary compatibility client. It presents the saved
ChatGPT URL as an external link. Showing a link never acknowledges a conversation
as inspected. There is no iframe, remote-desktop viewer, signaling proxy or stream.

See [desktop architecture](../../../desktop/README.md),
[validation](../../../desktop/VALIDATION.md) and
[operational retirement plan](../../../desktop/NEKO-MIGRATION.md).

Regression checks:

```sh
node --test packages/web/src/agency/*.test.mjs
pnpm --filter @agent-workbench/desktop test
xvfb-run -a pnpm --filter @agent-workbench/desktop test:electron
```

The browser tests retain CLI input, mixed ordering, notification safety, rename,
reconnect and independent web closure coverage. Electron tests separately cover
native attachment, lifetime, bounds, fullscreen, boundary validation and cold
synthetic cookie storage. Live login requires a real user; those results are
recorded separately in the validation report.
