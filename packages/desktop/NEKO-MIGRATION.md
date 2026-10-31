# Neko retirement: source removed, operational migration pending

The owner authorized full repository removal during this experiment. This branch
removes the React viewer and streaming model, backend viewer/proxy and controller
drivers, browser-target polling, `infra/neko` Compose/controller/configuration,
fixture/audit launchers and obsolete transport tests. The backend is now a logical
web-tab store. These are source changes in the isolated worktree only.

No installed service, running Neko container, Docker volume, browser profile,
credentials or backup has been stopped, changed, imported or deleted. This PR must
not be merged or deployed automatically. The existing production installation is
the rollback environment until a separate cutover is approved.

1. Complete the final desktop/manual acceptance checklist in [VALIDATION.md](VALIDATION.md),
   including provider-specific login, reboot/keyring, background streaming, focus,
   shortcuts, notifications, memory pressure, resizing and browser compatibility.
2. Package the Ubuntu desktop with a supported sandbox installation and a stable,
   private profile path. Keep the existing Node service/systemd and CLI/PTY owners.
   Review equal-workload RSS/PSS measurements before setting a production memory budget.
3. Back up logical workspace/tab metadata and record UUIDs, order, title, selection,
   URLs and any legacy ownership/cleanup ledger. Existing target receipts remain
   inert compatibility fields; they authorize no native renderer operations.
   Retain the current Neko profile and credentials in their existing private storage.
   Never export their cookies to Electron; use a normal login in its dedicated session.
4. Migrate logical tabs with their existing UUIDs and workspace associations. Load
   views lazily from saved URLs. Allow normal `chat.openai.com` redirects; audit
   other legacy subdomains against the strict native destination allowlist.
   Preserve metadata and offer external fallback for unsupported destinations.
5. After a separately approved production cutover, deploy matching web/desktop/server
   versions together and verify CLI recovery and Brave compatibility. Check for active
   users or generations before stopping the old Neko stack. Keep its installed
   release, container configuration and all volumes available for rollback.
6. Remove obsolete production service/environment references only after confirming
   the new installation needs none of them. Do not prune unrelated Docker resources.
   Do not use `docker compose down -v`. Retiring runtime services is distinct from
   deleting profiles or credentials.
7. Delete Neko volumes, profiles, credentials or backups only after a later explicit
   approval naming the data and retention window. Successful testing, merging code
   or stopping a service does not authorize data erasure.

Rollback before data retirement: restore the retained previous backend/web release
and the still-preserved Neko infrastructure/profile, then reconcile its own saved
ownership ledger. The new Electron cookie store remains independent and is never
copied into the old browser.
