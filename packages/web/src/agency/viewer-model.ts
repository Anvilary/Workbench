/** The only embeddable surface is the authenticated, same-origin Neko client. */
export const NEKO_VIEWER_PATH = '/api/agency/browser/viewer/';
export const NEKO_STATUS_PATH = '/api/agency/browser/viewer/status';

export function isNekoViewerUrl(value: unknown, origin: string, workspaceId?: string, tabId?: string): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value, origin);
    return url.origin === origin && url.pathname === NEKO_VIEWER_PATH &&
      !url.username && !url.password && !url.hash &&
      (workspaceId && tabId
        ? url.searchParams.get('workspaceId') === workspaceId && url.searchParams.get('tabId') === tabId &&
          [...url.searchParams.keys()].length === 2
        : !url.search);
  } catch { return false; }
}

export function hasLiveVideo(video: {
  readyState: number; videoWidth: number; videoHeight: number; paused: boolean; ended: boolean;
}): boolean {
  return video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0 && !video.paused && !video.ended;
}
