/**
 * The state of every native browser view.
 *
 * This module only defines the shape. The one owner of the state is the
 * BrowserViewController (view-controller.mjs), which creates it and is the only
 * code allowed to hand it to its private collaborators: view-layout,
 * navigation-guard, browser-sessions, view-eviction, page-commands and
 * profile-operations. Nothing outside src/browser/ holds this object.
 */

export function createBrowserViewState() {
  return {
    views: new Map(),
    urls: new Map(),
    providers: new Map(),
    profileIds: new Map(), // id -> browserProfileId
    cloningProfiles: new Set(),
    requestedUrls: new Map(),
    failures: new Map(),
    popups: new Set(),
    popupOwners: new Map(), // popup WebContents -> tabId
    authEntryUrls: new WeakMap(), // WebContents -> relying-party URL before sign-in
    attachedViews: new Map(), // id -> WebContentsView (up to 4 simultaneously visible)
    suspendedTabs: new Map(), // id -> { id, provider, profileId, url, requestedUrl, zoomLevel, suspendedAt }
    lastAccessedAt: new Map(), // id -> number (timestamp)
    activeDownloads: new Map(), // id -> number (count)
    reservedDownloadPaths: new Set(), // full file paths reserved for in-flight downloads
    interactionProtected: new Set(),
    // id -> { [reason]: timestamp }. When a protection reason was first observed, for
    // protection-age telemetry only. It never influences eviction decisions.
    protectionSince: new Map(),
    zoomLevels: new Map(), // id -> number
    tabFavicons: new Map(), // id -> string (best validated favicon URL)
    linkOpenHistory: new Map(),
    findRequests: new Map(), // tabId -> { requestId, searchId, text }
    // Native clicks must not make an unchanged renderer layout look like a new focus request.
    layoutFocusedId: null,
    reportedFocusedId: null,
  };
}

/** Stamps the first moment a protection reason was observed for a view. Idempotent. */
export function markProtectionReason(state, id, reason, now = Date.now()) {
  if (!id || !reason) return;
  const entry = state.protectionSince.get(id);
  if (!entry) {
    state.protectionSince.set(id, { [reason]: now });
    return;
  }
  if (entry[reason] === undefined) entry[reason] = now;
}

/** Drops one protection reason stamp (the reason no longer applies). */
export function clearProtectionReason(state, id, reason) {
  const entry = state.protectionSince.get(id);
  if (!entry) return;
  delete entry[reason];
  if (Object.keys(entry).length === 0) state.protectionSince.delete(id);
}

/** Drops every protection stamp of a view (closed, evicted or shut down). */
export function clearProtectionReasons(state, id) {
  state.protectionSince.delete(id);
}
