/**
 * The one Trailer Department navigation catalog: five destinations.
 *
 * Both the main admin sidebar (App.jsx) and TrailerDepartmentShell read this
 * list, so a section's route, label, and permissions are never defined twice.
 * The server permission middleware stays authoritative — this only decides what
 * is worth showing. Old section keys keep working: trailerSectionFromPath maps
 * every legacy key to its new home (and trailerLegacyTab to the right sub-tab).
 */
export const TRAILER_BASE_PATH = "/admin/trailers";
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
 * Reads the section out of /admin/trailers/{section}. Legacy keys land on
 * their new section; unknown paths fall back to Home.
 */
export function trailerSectionFromPath(pathname) {
  const key = String(pathname || "").split("/")[3] || "";
  if (TRAILER_SECTIONS.some((section) => section.key === key)) return key;
  if (TRAILER_LEGACY_SECTIONS[key]) return TRAILER_LEGACY_SECTIONS[key].section;
  return TRAILER_DEFAULT_SECTION;
}

/** The sub-tab a legacy deep link should open inside its new section. */
export function trailerLegacyTab(pathname) {
  const key = String(pathname || "").split("/")[3] || "";
  return TRAILER_LEGACY_SECTIONS[key]?.tab || null;
}

/** Home when permitted, otherwise the first section the user may open. */
export function defaultTrailerSection(permissions) {
  const allowed = permittedTrailerSections(permissions);
  const home = allowed.find((section) => section.key === TRAILER_DEFAULT_SECTION);
  return (home || allowed[0])?.key || TRAILER_DEFAULT_SECTION;
}
