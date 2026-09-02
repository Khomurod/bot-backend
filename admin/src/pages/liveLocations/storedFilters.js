import { DEFAULT_FILTERS, sanitizeFilters } from "../../utils/assetMapFilters";

/**
 * The trailer/truck overlay filter selection, remembered per browser.
 *
 * This is a per-viewer convenience, not shared state: a dispatcher who works
 * trailers only should not have to re-pick the overlay on every visit. Every
 * read goes through sanitizeFilters, so a stored value from an older version
 * of the page (or hand-edited storage) cannot put the map into a shape the
 * filters no longer understand, and a browser that refuses localStorage
 * entirely falls back to the defaults.
 *
 * Split out of admin/src/pages/LiveLocationsPage.jsx.
 */
export const ASSET_FILTERS_STORAGE_KEY = "admin.liveLocations.assetFilters.v1";

export function loadStoredAssetFilters() {
  try {
    return sanitizeFilters(JSON.parse(localStorage.getItem(ASSET_FILTERS_STORAGE_KEY) || "null"));
  } catch (_) {
    return { ...DEFAULT_FILTERS };
  }
}
