const BASE = "/api/trailer-department";

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
  const res = await fetch(`${BASE}${path}`, { ...options, headers });
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
export const status = () => request("/status");
export const home = () => request("/home");
export const rentalList = (filters = {}) => {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) if (v != null && v !== "") params.set(k, v);
  return request(`/rental-list?${params}`);
};
export const rentalOverview = (agreementId) => request(`/rental-list/${agreementId}`);
export const companyCredits = (companyId) => request(`/companies/${companyId}/credits`);
export const applyCredit = (creditId, body) =>
  request(`/credits/${creditId}/apply`, { method: "POST", body: JSON.stringify(body) });
export const invoice = (id) => request(`/invoices/${id}`);
export const dashboard = (filters = {}) =>
  request(`/dashboard?${new URLSearchParams(filters)}`);
export const trailers = (filters = {}) =>
  request(`/trailers?${new URLSearchParams(filters)}`);
export const createTrailer = (body) =>
  request("/trailers", { method: "POST", body: JSON.stringify(body) });
export const updateTrailer = (id, body) =>
  request(`/trailers/${id}`, { method: "PUT", body: JSON.stringify(body) });
export const companies = (filters = {}) =>
  request(`/companies?${new URLSearchParams(filters)}`);
export const createCompany = (body) =>
  request("/companies", { method: "POST", body: JSON.stringify(body) });
export const updateCompany = (id, body) =>
  request(`/companies/${id}`, { method: "PUT", body: JSON.stringify(body) });
export const rentals = (filters = {}) =>
  request(`/rentals?${new URLSearchParams(filters)}`);
export const rental = (id) => request(`/rentals/${id}`);
export const createRental = (body) =>
  request("/rentals", { method: "POST", body: JSON.stringify(body) });
export const updateRental = (id, body) =>
  request(`/rentals/${id}`, { method: "PUT", body: JSON.stringify(body) });
// Saving always produces a DRAFT — the backend ignores any `completed` flag.
// Completion is a separate step, allowed only once the required photo's bytes
// are genuinely stored.
export const saveInspection = (id, type, body) =>
  request(`/rentals/${id}/inspections/${type}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
export const completeInspection = (id, type) =>
  request(`/rentals/${id}/inspections/${type}/complete`, { method: "POST", body: "{}" });
export const activateRental = (id) =>
  request(`/rentals/${id}/activate`, { method: "POST", body: "{}" });
export const returnRental = (id, body) =>
  request(`/rentals/${id}/return`, {
    method: "POST",
    body: JSON.stringify(body),
  });
export const uploadMedia = (files, fields) => {
  const body = new FormData();
  for (const file of files) body.append("files", file);
  for (const [k, v] of Object.entries(fields)) if (v != null) body.append(k, v);
  return request("/media", { method: "POST", body });
};
export const invoices = (filters = {}) =>
  request(`/invoices?${new URLSearchParams(filters)}`);
export const recordPayment = (fields, file) => {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v != null) body.append(k, v);
  if (file) body.append("receipt", file);
  return request("/payments", { method: "POST", body });
};
export const reversePayment = (id, reason) =>
  request(`/payments/${id}/reverse`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  });
export const mapData = (filters = {}) =>
  request(`/map?${new URLSearchParams(filters)}`);
export const settings = () => request("/settings");
export const updateSettings = (body) =>
  request("/settings", { method: "PUT", body: JSON.stringify(body) });
export const testTelegram = (target) =>
  request(`/settings/test/${target}`, { method: "POST", body: "{}" });
export const report = (name) => request(`/reports/${name}`);
export async function downloadReport(name) {
  const res = await request(`/reports/${name}?format=csv`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${name}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}
export const reminderAction = (invoiceId, body) =>
  request(`/invoices/${invoiceId}/reminder-action`, {
    method: "POST",
    body: JSON.stringify(body),
  });

export async function adminUsers() {
  const res = await fetch("/api/admin/users", { headers: auth() });
  if (!res.ok) throw new Error((await res.json()).error);
  return res.json();
}
export async function roles() {
  const res = await fetch("/api/admin/roles", { headers: auth() });
  if (!res.ok) throw new Error((await res.json()).error);
  return res.json();
}
export async function saveAdminUser(id, body) {
  const res = await fetch(`/api/admin/users${id ? `/${id}` : ""}`, {
    method: id ? "PUT" : "POST",
    headers: { ...auth(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error((await res.json()).error);
  return res.json();
}
export async function saveRole(id, body) {
  const res = await fetch(`/api/admin/roles/${id}`, { method: "PUT", headers: { ...auth(), "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error((await res.json()).error);
  return res.json();
}

export default {
  status,
  home,
  rentalList,
  rentalOverview,
  companyCredits,
  applyCredit,
  invoice,
  dashboard,
  trailers,
  createTrailer,
  updateTrailer,
  companies,
  createCompany,
  updateCompany,
  rentals,
  rental,
  createRental,
  updateRental,
  saveInspection,
  completeInspection,
  activateRental,
  returnRental,
  uploadMedia,
  invoices,
  recordPayment,
  reversePayment,
  mapData,
  settings,
  updateSettings,
  testTelegram,
  report,
  downloadReport,
  reminderAction,
  adminUsers,
  roles,
  saveAdminUser,
  saveRole,
};
