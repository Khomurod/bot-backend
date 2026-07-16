/**
 * The one Trailer Department navigation catalog.
 *
 * Both the main admin sidebar (App.jsx) and TrailerDepartmentShell read this
 * list, so a section's route, label, and permissions are never defined twice.
 * The server permission middleware stays authoritative — this only decides what
 * is worth showing.
 */
export const TRAILER_BASE_PATH = "/admin/trailers";
export const TRAILER_DEFAULT_SECTION = "dashboard";

export const TRAILER_SECTIONS = [
  { key: "dashboard", label: "Dashboard", icon: "📊", permissions: ["trailers.view"] },
  { key: "rentals", label: "Rentals", icon: "📄", permissions: ["trailer_rentals.view"] },
  { key: "trailers", label: "Trailers", icon: "🚛", permissions: ["trailers.view"] },
  {
    key: "companies",
    label: "Companies",
    icon: "🏭",
    permissions: ["trailer_rentals.view", "trailer_companies.manage"],
  },
  { key: "payments", label: "Payments", icon: "💳", permissions: ["trailer_payments.view"] },
  { key: "map", label: "Trailer Map", icon: "🗺️", permissions: ["trailer_map.view"] },
  { key: "reports", label: "Reports", icon: "📈", permissions: ["trailer_reports.view"] },
  { key: "tracking", label: "AI Tracking", icon: "🤖", permissions: ["trailers.view"] },
  { key: "settings", label: "Settings", icon: "⚙️", permissions: ["trailer_settings.manage"] },
  { key: "users", label: "Trailer Users", icon: "👥", permissions: ["trailer_users.manage"] },
];

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

/** Reads the section out of /admin/trailers/{section}; unknown paths fall back. */
export function trailerSectionFromPath(pathname) {
  const key = String(pathname || "").split("/")[3] || "";
  return TRAILER_SECTIONS.some((section) => section.key === key)
    ? key
    : TRAILER_DEFAULT_SECTION;
}

/** Dashboard when permitted, otherwise the first section the user may open. */
export function defaultTrailerSection(permissions) {
  const allowed = permittedTrailerSections(permissions);
  const dashboard = allowed.find((section) => section.key === TRAILER_DEFAULT_SECTION);
  return (dashboard || allowed[0])?.key || TRAILER_DEFAULT_SECTION;
}
