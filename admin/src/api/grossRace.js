import { API_BASE, getAuthHeader, getHeaders, handleApiError } from "./http";
import { ApiError } from "./apiError";

/** The video /dispatchteam plays after the 4 PM celebration (public, like the race). */
export const GROSS_RACE_VIDEO_URL = `${API_BASE}/gross-race/video`;

/**
 * The Gross Grand Prix standings for one display: "teams" or "dispatchers".
 * Public, like the recruiters' leaderboard: no auth header. The server reads
 * Datatruck itself, so the page never holds a Datatruck token.
 */
export async function getGrossRace(view) {
  const res = await fetch(`${API_BASE}/gross-race?view=${encodeURIComponent(view)}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** The biggest video the server accepts (services/grossRace/celebrationVideo.js MAX_BYTES). */
export const GROSS_RACE_VIDEO_MAX_BYTES = 100 * 1024 * 1024;

/** Settings → Gross Grand Prix: { exists, bytes, updatedAt, paused, pausedChangedAt, pausedChangedBy, pauseError }. */
export async function getCelebrationVideoStatus() {
  const res = await fetch(`${API_BASE}/gross-race/video/status`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

/** Pause (true) or resume (false) the video after the 4 PM celebration. The file stays. */
export async function setCelebrationVideoPaused(paused) {
  const res = await fetch(`${API_BASE}/gross-race/video/paused`, {
    method: 'PUT', headers: getHeaders(), body: JSON.stringify({ paused }),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

/** Remove the video: the teams' board shows the car alone. */
export async function deleteCelebrationVideo() {
  const res = await fetch(`${API_BASE}/gross-race/video`, { method: 'DELETE', headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

/**
 * Replace the video with `file` (an MP4), reporting progress 0..1 to
 * `onProgress`. XMLHttpRequest rather than fetch, because fetch cannot report
 * how much of an upload has gone; the body is the file itself, as
 * PUT /api/gross-race/video expects, never a form.
 */
export function uploadCelebrationVideo(file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `${API_BASE}/gross-race/video`);
    const { Authorization } = getAuthHeader();
    if (Authorization) xhr.setRequestHeader('Authorization', Authorization);
    xhr.setRequestHeader('Content-Type', 'video/mp4');
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) onProgress(event.loaded / event.total);
    };
    xhr.onload = () => {
      let body = null;
      try { body = JSON.parse(xhr.responseText); } catch { /* not JSON: the status line explains it */ }
      if (xhr.status >= 200 && xhr.status < 300) { resolve(body); return; }
      reject(new ApiError((body && (body.error || body.message)) || `HTTP Error: ${xhr.status}`, {
        status: xhr.status, code: (body && body.code) || null,
      }));
    };
    xhr.onerror = () => reject(new Error('The upload was interrupted. Check the connection and try again.'));
    xhr.send(file);
  });
}
