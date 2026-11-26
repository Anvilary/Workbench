# Browser profiles, sessions and downloads

How the desktop shell isolates browser state and handles downloads, DevTools and spellcheck. Source: `packages/desktop/src/browser/` and `packages/desktop/src/security/`.

## Profiles and partitions

A browser profile is a set of Chromium partitions, one per provider. The partition name is derived in code (`partitionForBrowserProfile` in `packages/shared/src/browser/browser-profiles.ts` and `packages/desktop/policy.mjs`); it is never stored verbatim in app state, so the profile ID is the only persisted link.

| Profile | Provider | Partition |
|---|---|---|
| Main (default) | ChatGPT | `persist:workbench-chatgpt` |
| Main | GitHub | `persist:workbench-github` |
| Main | Perplexity | `persist:workbench-perplexity` |
| Main | other sites | `persist:workbench-browser` |
| custom `<id>` | each provider | `persist:workbench-profile-<id>-<provider>` |

Partitions are stored under `Partitions/` inside the desktop userData directory (`$XDG_DATA_HOME/workbench-desktop`). Installations that predate the identity migration use `persist:workbench-*` names until they run the [identity migration](../architecture/identity-migration.md); there is no runtime fallback to the legacy names.

Cookies are stored by Chromium without OS keyring encryption. Their confidentiality relies on the userData directory being private (mode 0700). Enabling keyring encryption later would itself be a migration.

`browser-sessions.mjs` configures each partition the first time it is used (permissions, spellcheck, downloads) and remembers which provider it belongs to. Permission requests are limited per provider to same-origin pages of that provider (`session-permissions.mjs`), and local or private network destinations are filtered.

## Profile operations

`profile-operations.mjs` and `security/browser-profile-storage.mjs` implement clone, clear the sign-in of one site, and delete. They first quiesce the live views and popups of the affected partitions so page scripts cannot re-persist state.

- Cloning works through Electron's live cookie API (`flushStore`, `cookies.get`, `cookies.set`), never by copying partition directories of a live session, which risks LevelDB and SQLite corruption. Cloned profiles inherit HTTP cookies (except excluded sites); origin-scoped Local Storage and IndexedDB are not copied. The source partition is never mutated.
- Raw cookie values and tokens never cross IPC.

## Downloads

`downloads.mjs` handles the `will-download` event of every partition:

- Only downloads from a registered view (or a popup owned by one) of the same provider are accepted; others are cancelled.
- `blob:` downloads must come from an allowed origin and a single-entry URL chain.
- File names are sanitized; duplicates get a numbered suffix, and concurrent downloads reserve their target paths.
- The default directory is the system Downloads folder; the last directory used for a completed download is remembered in `download-preferences.json` in userData, and only reused while it is an absolute, writable directory.
- A view with an active download is never evicted (see [budget policy](../performance/budget-policy.md)).

## DevTools

Inspect opens detached DevTools for the view (`page-commands.mjs`), optionally at the clicked element. A view with open DevTools is protected from eviction below critical memory pressure.

## Spellcheck

Every view is created with `spellcheck: true`. The renderer can list available languages, read the status and change the enabled languages; the change is applied to every partition (`setSpellCheckerLanguages`). Dictionary download progress (`downloading`, `ready`, `failed`) is reported per language. Custom words are stored per partition (`Dictionaries`) and move with the userData directory.

## Zoom and page commands

Back, forward, reload, copy, bounded zoom, spellcheck replacement, opening links, find in page and capture are page commands routed through the `BrowserViewController`.

## WebAuthn

Hardware security key sign-in for allowed origins is handled by a dedicated bridge; see [WebAuthn](../security/webauthn.md).
