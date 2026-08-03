/**
 * The one Trailer Department navigation catalog: five destinations.
 *
 * Both the main admin sidebar (App.jsx) and TrailerDepartmentShell read this
 * list, so a section's route, label, and permissions are never defined twice.
 * The server permission middleware stays authoritative — this only decides what
 * is worth showing. Old section keys keep working: trailerSectionFromPath maps
 * every legacy key to its new home (and trailerLegacyTab to the right sub-tab).
 *
 * `/trailers` is the public-facing slug. `/admin/trailers` was the original one
 * and stays readable forever: every path helper accepts either prefix, and
 * canonicalTrailerUrl rewrites a legacy URL to its `/trailers` equivalent
 * without dropping the section, the record, the filters, or the sub-tab.
 */
export const TRAILER_BASE_PATH = "/trailers";
export const TRAILER_LEGACY_BASE_PATH = "/admin/trailers";
export const TRAILER_DEFAULT_SECTION = "home";

const MANAGER_PERMISSIONS = [
  "trailer_companies.manage",
  "trailer_imports.manage",
  "trailer_reports.view",
  "trailer_settings.manage",
  "trailer_users.manage",
];

export const TRAILER_SECTIONS = [
  {
    key: "home",
    label: "Home",
    icon: "🏠",
    permissions: ["trailers.view", "trailer_rentals.view", "trailer_payments.view"],
  },
  {
    key: "rentals",
    label: "Rentals",
    icon: "📄",
    permissions: ["trailer_rentals.view", "trailer_agreements.view"],
  },
  { key: "trailers", label: "Trailers", icon: "🚛", permissions: ["trailers.view"] },
  { key: "money", label: "Money", icon: "💵", permissions: ["trailer_payments.view"] },
  { key: "more", label: "More", icon: "⚙️", permissions: MANAGER_PERMISSIONS },
];

/** Where each pre-redesign section key lives now: new section + sub-tab. */
export const TRAILER_LEGACY_SECTIONS = {
  dashboard: { section: "home" },
  agreements: { section: "rentals" },
  payments: { section: "money" },
  map: { section: "trailers", tab: "map" },
  tracking: { section: "trailers", tab: "updates" },
  mentions: { section: "trailers", tab: "updates" },
  masterImport: { section: "more", tab: "trailer-list" },
  companies: { section: "more", tab: "companies" },
  reports: { section: "more", tab: "reports" },
  settings: { section: "more", tab: "settings" },
  users: { section: "more", tab: "team" },
};

/**
 * A full administrator holds admin.full_access and, in a seeded database, every
 * trailer permission as well. Treating full access as a wildcard keeps the menu
 * correct even for the legacy auth fallback, which grants only that one key.
 */
export function hasTrailerPermission(permissions, ...needed) {
  const held = new Set(permissions || []);
  return held.has("admin.full_access") || needed.some((key) => held.has(key));
}

export function permittedTrailerSections(permissions) {
  return TRAILER_SECTIONS.filter((section) =>
    hasTrailerPermission(permissions, ...section.permissions),
  );
}

export function trailerSectionPath(key) {
  return `${TRAILER_BASE_PATH}/${key}`;
}

/**
 * The path segments after the department root, for either prefix:
 * `/trailers/money` and `/admin/trailers/money` both yield ["money"].
 * Returns null when the path is not a Trailer Department path at all.
 */
function trailerPathSegments(pathname) {
  const segments = String(pathname || "").split("/").filter(Boolean);
  if (segments[0] === "admin") segments.shift();
  if (segments[0] !== "trailers") return null;
  return segments.slice(1);
}

/** True for /trailers, /trailers/…, /admin/trailers and /admin/trailers/…. */
export function isTrailerPath(pathname) {
  return trailerPathSegments(pathname) !== null;
}

/** True only for the superseded /admin/trailers prefix. */
export function isLegacyTrailerPath(pathname) {
  const path = String(pathname || "");
  return path === TRAILER_LEGACY_BASE_PATH || path.startsWith(`${TRAILER_LEGACY_BASE_PATH}/`);
}

/**
 * Reads the section out of /trailers/{section} (or the legacy
 * /admin/trailers/{section}). Legacy section keys land on their new section;
 * unknown paths fall back to Home.
 */
export function trailerSectionFromPath(pathname) {
  const key = trailerPathSegments(pathname)?.[0] || "";
  if (TRAILER_SECTIONS.some((section) => section.key === key)) return key;
  if (TRAILER_LEGACY_SECTIONS[key]) return TRAILER_LEGACY_SECTIONS[key].section;
  return TRAILER_DEFAULT_SECTION;
}

/** The sub-tab a legacy deep link should open inside its new section. */
export function trailerLegacyTab(pathname) {
  const key = trailerPathSegments(pathname)?.[0] || "";
  return TRAILER_LEGACY_SECTIONS[key]?.tab || null;
}

/**
 * The canonical `/trailers/…` URL for any Trailer Department location.
 *
 * A bookmark on `/admin/trailers/map?trailer=42` must not lose anything: the
 * legacy `map` key becomes section `trailers` with `?tab=map`, and every other
 * query parameter (`trailer=42`) survives untouched. An explicit `?tab=` in the
 * original URL wins over the one implied by the legacy section key.
 *
 * Returns null when `pathname` is not a Trailer Department path.
 */
export function canonicalTrailerUrl(pathname, search = "") {
  if (!isTrailerPath(pathname)) return null;
  const section = trailerSectionFromPath(pathname);
  const params = new URLSearchParams(search || "");
  const legacyTab = trailerLegacyTab(pathname);
  if (legacyTab && !params.get("tab")) params.set("tab", legacyTab);
  const query = params.toString();
  return trailerSectionPath(section) + (query ? `?${query}` : "");
}

/** Home when permitted, otherwise the first section the user may open. */
export function defaultTrailerSection(permissions) {
  const allowed = permittedTrailerSections(permissions);
  const home = allowed.find((section) => section.key === TRAILER_DEFAULT_SECTION);
  return (home || allowed[0])?.key || TRAILER_DEFAULT_SECTION;
}
