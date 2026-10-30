import React, { useRef } from "react";

/**
 * The one tab bar of the admin panel.
 *
 * Every tabbed screen drew its own — pill buttons, underlined text, a grid of
 * big buttons — so moving between pages looked like moving between products.
 * This is the shared control: a quiet rounded track with the open tab raised
 * (the shadcn/ui Tabs pattern), wrapping onto a second line when there are
 * many tabs rather than hiding any of them.
 *
 * It only DRAWS tabs. Each page still owns its own state and its own
 * `onChange`, exactly as before, so no page's behaviour moved here.
 *
 * Accessible as a WAI-ARIA tablist: each tab has role="tab" and
 * aria-selected. ←/→ (Home/End) move FOCUS between tabs and Enter or Space
 * opens one ("manual activation"), so arrowing across Settings does not open —
 * and load — every tab on the way, or drop unsaved edits on the first key.
 *
 * @param {Array<{key: string, label: React.ReactNode, title?: string}>} tabs
 * @param {string} value     the open tab's key
 * @param {Function} onChange called with the clicked tab's key
 * @param {string} ariaLabel what the tabs choose between, for screen readers
 * @param {"md"|"sm"} [size]
 */
export default function TabBar({ tabs, value, onChange, ariaLabel, size = "md", className = "", style }) {
  const refs = useRef([]);

  const focusTab = (index) => {
    const count = tabs.length;
    refs.current[((index % count) + count) % count]?.focus();
  };

  const onKeyDown = (event, index) => {
    if (event.key === "ArrowRight") { event.preventDefault(); focusTab(index + 1); }
    else if (event.key === "ArrowLeft") { event.preventDefault(); focusTab(index - 1); }
    else if (event.key === "Home") { event.preventDefault(); focusTab(0); }
    else if (event.key === "End") { event.preventDefault(); focusTab(tabs.length - 1); }
  };

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={`wz-tabs ${size === "sm" ? "wz-tabs--sm" : ""} ${className}`.trim()}
      style={style}
    >
      {tabs.map((tab, index) => {
        const selected = tab.key === value;
        return (
          <button
            key={tab.key}
            ref={(el) => { refs.current[index] = el; }}
            type="button"
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            title={tab.title}
            className={`wz-tab ${selected ? "is-active" : ""}`}
            onClick={() => onChange(tab.key)}
            onKeyDown={(event) => onKeyDown(event, index)}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
