import React, { useCallback, useEffect, useState } from "react";
import { trailerLegacyTab } from "../trailerNavigation";

/**
 * Sub-tabs inside a Trailer Department section.
 *
 * The active tab persists in the URL (?tab=) so links are shareable and legacy
 * deep links (/admin/trailers/map → Trailers?tab=map) land on the right tab.
 * Only tabs the user may see are rendered — no disabled ghosts.
 */
export function useSectionTab(tabs, fallback) {
  const readTab = useCallback(() => {
    const fromQuery = new URLSearchParams(window.location.search).get("tab");
    const legacy = trailerLegacyTab(window.location.pathname);
    const candidate = fromQuery || legacy || fallback;
    return tabs.some((t) => t.key === candidate) ? candidate : (tabs[0]?.key || fallback);
  }, [tabs, fallback]);

  const [tab, setTabState] = useState(readTab);

  useEffect(() => {
    const onPop = () => setTabState(readTab());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [readTab]);

  const setTab = useCallback((next) => {
    const url = new URL(window.location.href);
    url.searchParams.set("tab", next);
    window.history.replaceState({}, "", url);
    setTabState(next);
  }, []);

  return [tab, setTab];
}

export default function SectionTabs({ tabs, active, onChange }) {
  if (!tabs.length) return null;
  return (
    <div className="trailer-section-tabs" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.key}
          type="button"
          role="tab"
          aria-selected={active === t.key}
          className={`trailer-section-tab ${active === t.key ? "active" : ""}`}
          onClick={() => onChange(t.key)}
        >
          {t.label}
          {t.badge ? <span className="trailer-tab-badge">{t.badge}</span> : null}
        </button>
      ))}
    </div>
  );
}
