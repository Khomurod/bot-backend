/**
 * The error type every failed API call throws.
 *
 * WHY IT EXISTS. `handleApiError` used to throw a bare `Error` carrying only a
 * message, so nothing downstream could tell an expired session from a
 * permission problem from a Supabase outage — every failure reached the UI as
 * one indistinguishable string, and the admin panel showed one
 * indistinguishable message for all of them.
 *
 * `message` is still exactly what it was, so the ~200 call sites that do
 * `catch (e) { setError(e.message) }` keep working untouched. The status, the
 * server's machine-readable `code`, and whether the body was HTML are added
 * ALONGSIDE it, for admin/src/utils/pageFailure.js to classify.
 */
export class ApiError extends Error {
  constructor(message, { status = 0, code = null, detail = null, url = null, htmlBody = false } = {}) {
    super(message);
    this.name = 'ApiError';
    /** HTTP status; 0 when the request never produced a response. */
    this.status = status;
    /** Machine-readable failure code from the API, when it sent one. */
    this.code = code;
    this.detail = detail;
    this.url = url;
    /**
     * True when the API answered with HTML instead of JSON — which means the
     * request hit the SPA catch-all rather than an API route: this browser tab
     * is asking for an endpoint the deployed server does not have.
     */
    this.htmlBody = htmlBody;
  }
}

/** Is this error one of ours, carrying a classified HTTP failure? */
export function isApiError(error) {
  return Boolean(error) && (error instanceof ApiError || error.name === 'ApiError');
}
