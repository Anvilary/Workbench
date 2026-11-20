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
    interactionProtected: new Set(),
    zoomLevels: new Map(), // id -> number
    tabFavicons: new Map(), // id -> string (best validated favicon URL)
    linkOpenHistory: new Map(),
    // Native clicks must not make an unchanged renderer layout look like a new focus request.
    layoutFocusedId: null,
    reportedFocusedId: null,
  };
}
