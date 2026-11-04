/**
 * Settings → System → Secrets: the deployment's settings, stored in the app.
 *
 * A value goes to the server only inside an uploaded .env text (preview and
 * save) and never comes back: the server answers with names, scopes and the
 * last four characters of long values.
 */
import { API_BASE, getHeaders, handleApiError } from './http';

async function call(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${API_BASE}/settings${path}`, {
    method,
    headers: getHeaders(),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export function getAppSecrets() {
  return call('/app-secrets');
}

/** What the file would change. Nothing is saved. → { preview } */
export async function previewAppSecrets({ target, text }) {
  const data = await call('/app-secrets/preview', { method: 'POST', body: { target, text } });
  return data.preview;
}

/** Save as a new version; the app restarts itself when its own values changed. */
export function saveAppSecrets({ target, text, baseVersion }) {
  return call('/app-secrets', { method: 'PUT', body: { target, text, baseVersion } });
}

export function removeAppSecret(scope, name) {
  return call(`/app-secrets/${encodeURIComponent(scope)}/${encodeURIComponent(name)}`, { method: 'DELETE' });
}

export function restoreAppSecretsVersion(id) {
  return call(`/app-secrets/versions/${encodeURIComponent(id)}/restore`, { method: 'POST' });
}
