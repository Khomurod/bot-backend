import React, { useCallback, useEffect, useRef, useState } from "react";
import { trailerLegacyTab } from "../trailerNavigation";
import { nextTabIndex } from "../a11y/keys";

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

const tabId = (base, key) => `${base}-tab-${key}`;
const panelId = (base) => `${base}-panel`;

/**
 * Accessible tablist (§8): roving tabindex (only the selected tab is in the tab
 * sequence), arrow/Home/End key navigation that moves focus and selection, and
 * each tab wired to the shared tabpanel via aria-controls. `idBase` namespaces
 * the ids so several tablists can coexist.
 */
export default function SectionTabs({ tabs, active, onChange, idBase = "trailer-section" }) {
  const refs = useRef({});
  if (!tabs.length) return null;
  const activeIndex = Math.max(0, tabs.findIndex((t) => t.key === active));

  const onKeyDown = (e) => {
    const next = nextTabIndex(activeIndex, tabs.length, e.key);
    if (next === activeIndex && !["Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const key = tabs[next].key;
    onChange(key);
    refs.current[key]?.focus();
  };

  return (
    <div className="trailer-section-tabs" role="tablist" onKeyDown={onKeyDown}>
      {tabs.map((t) => {
        const selected = active === t.key;
        return (
          <button
            key={t.key}
            ref={(el) => { refs.current[t.key] = el; }}
            type="button"
            role="tab"
            id={tabId(idBase, t.key)}
            aria-selected={selected}
            aria-controls={panelId(idBase)}
            tabIndex={selected ? 0 : -1}
            className={`trailer-section-tab ${selected ? "active" : ""}`}
            onClick={() => onChange(t.key)}
          >
            {t.label}
            {t.badge ? <span className="trailer-tab-badge">{t.badge}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

/** The tabpanel that a SectionTabs controls. Wrap the active tab's content. */
export function TabPanel({ idBase = "trailer-section", activeKey, children }) {
  return (
    <div
      role="tabpanel"
      id={panelId(idBase)}
      aria-labelledby={activeKey ? tabId(idBase, activeKey) : undefined}
      tabIndex={0}
    >
      {children}
    </div>
  );
}
