/**
 * API client for the multi-trailer Agreements, master-list Imports, and
 * unmatched-Mentions endpoints. These live OUTSIDE /api/trailer-department, so
 * this helper fetches absolute paths while reusing the same Bearer-token auth
 * and error-handling shape as api/trailerDepartment.js.
 */
function auth() {
  const token = localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function request(path, options = {}) {
  const headers = {
    ...auth(),
    ...(options.body instanceof FormData
      ? {}
      : { "Content-Type": "application/json" }),
    ...(options.headers || {}),
  };
  const res = await fetch(path, { ...options, headers });
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      message = (await res.json()).error || message;
    } catch (_) {}
    throw new Error(message);
  }
  const type = res.headers.get("content-type") || "";
  return type.includes("application/json") ? res.json() : res;
}

const post = (path, body) =>
  request(path, { method: "POST", body: JSON.stringify(body || {}) });

// ─── Agreements ───
const AG = "/api/trailer-agreements";
export const listAgreements = (filters = {}) =>
  request(`${AG}?${new URLSearchParams(filters)}`);
export const getAgreement = (id) => request(`${AG}/${id}`);
export const createAgreement = (body) => post(AG, body);
// Server-side estimate for the wizard's Price step — same math as invoicing.
export const estimateAgreement = (body) => post(`${AG}/estimate`, body);
export const addItem = (id, item, reason) =>
  post(`${AG}/${id}/items`, { item, reason });
export const removeItem = (id, itemId, reason) =>
  post(`${AG}/${id}/items/${itemId}/remove`, { reason });
export const replaceItem = (id, itemId, item, reason) =>
  post(`${AG}/${id}/items/${itemId}/replace`, { item, reason });
export const scheduleItem = (id, itemId, body) =>
  post(`${AG}/${id}/items/${itemId}/schedule`, body);
// Confirm pickup for one item. `pickup` carries the ACTUAL details recorded on
// the ground (time, location, optional lat/lng) so the server stores and bills
// them instead of the scheduled plan.
export const activateItem = (id, itemId, version, pickup = {}) =>
  post(`${AG}/${id}/items/${itemId}/activate`, {
    ...(version != null ? { version } : {}),
    ...pickup,
  });
export const returnItem = (id, itemId, body) =>
  post(`${AG}/${id}/items/${itemId}/return`, body);
// Item-scoped inspections: saving is ALWAYS a draft; completion verifies the
// required fields and the stored photo bytes on the server.
export const saveItemInspection = (id, itemId, type, body) =>
  request(`${AG}/${id}/items/${itemId}/inspections/${type}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
export const completeItemInspection = (id, itemId, type) =>
  post(`${AG}/${id}/items/${itemId}/inspections/${type}/complete`, {});
export const extendItem = (id, itemId, expected_return_at, reason) =>
  post(`${AG}/${id}/items/${itemId}/extend`, { expected_return_at, reason });
export const changeAmount = (id, amount, reason) =>
  post(`${AG}/${id}/amount`, { amount, reason });
export const combinedInvoice = (id) => post(`${AG}/${id}/invoices/combined`, {});
export const itemInvoice = (id, itemId) =>
  post(`${AG}/${id}/items/${itemId}/invoice`, {});
export const closeAgreement = (id, version) =>
  post(`${AG}/${id}/close`, version != null ? { version } : {});

// ─── Master list imports ───
const ML = "/api/trailer-master-list";
export const listImports = (filters = {}) =>
  request(`${ML}/imports?${new URLSearchParams(filters)}`);
export const getImport = (id) => request(`${ML}/imports/${id}`);
export const importReconciliation = (id) =>
  request(`${ML}/imports/${id}/reconciliation`);
export const confirmImport = (id) => post(`${ML}/imports/${id}/confirm`, {});
export const reconcileImport = (id, decisions) =>
  post(`${ML}/imports/${id}/reconcile`, { decisions });
export const uploadImport = (files) => {
  const body = new FormData();
  for (const file of files) body.append("images", file);
  return request(`${ML}/imports`, { method: "POST", body });
};

// ─── Unmatched mentions ───
export const listMentions = (filters = {}) =>
  request(`${ML}/mentions?${new URLSearchParams(filters)}`);
export const mentionsCount = () => request(`${ML}/mentions/count`);
// The backend records the decision under `review_status`
// ('linked' | 'created' | 'ignored' | 'false_detection').
export const resolveMention = (id, body) =>
  post(`${ML}/mentions/${id}/resolve`, body);

export default {
  listAgreements,
  getAgreement,
  createAgreement,
  estimateAgreement,
  addItem,
  removeItem,
  replaceItem,
  scheduleItem,
  activateItem,
  returnItem,
  saveItemInspection,
  completeItemInspection,
  extendItem,
  changeAmount,
  combinedInvoice,
  itemInvoice,
  closeAgreement,
  listImports,
  getImport,
  importReconciliation,
  confirmImport,
  reconcileImport,
  uploadImport,
  listMentions,
  mentionsCount,
  resolveMention,
};
