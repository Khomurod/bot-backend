import React, { useEffect, useMemo, useRef, useState } from "react";
import { filterGroupOptions } from "../routeControlGroupSearch.mjs";

/**
 * A type-to-filter driver-group picker with keyboard navigation.
 *
 * A plain <select> is unusable here: the option list is every driver group in
 * the company, and assigning a route to the wrong one sends a stranger's route
 * into a driver's Telegram group. Filtering and an explicit highlighted choice
 * make the selection deliberate.
 *
 * Split out of admin/src/pages/RouteControlPage.jsx.
 */
export function SearchableGroupSelect({ options, value, onChange, disabled }) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const wrapRef = useRef(null);

  const selected = useMemo(
    () => options.find((o) => o.groupId === Number(value)) || null,
    [options, value]
  );

  const filtered = useMemo(() => filterGroupOptions(options, query), [options, query]);

  useEffect(() => {
    function onDocClick(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  useEffect(() => { setHighlight(0); }, [query, open]);

  const choose = (opt) => {
    if (!opt) return;
    onChange(String(opt.groupId));
    setQuery("");
    setOpen(false);
  };

  const onKeyDown = (e) => {
    if (!open && (e.key === "ArrowDown" || e.key === "Enter")) { setOpen(true); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setHighlight((h) => Math.min(h + 1, filtered.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHighlight((h) => Math.max(h - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); choose(filtered[highlight]); }
    else if (e.key === "Escape") { setOpen(false); }
  };

  const displayText = open ? query : (selected ? selected.label : "");

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <input
        className="form-input"
        role="combobox"
        aria-expanded={open}
        aria-label="Search driver group"
        disabled={disabled}
        placeholder={selected ? selected.label : "Search unit #, driver name or group…"}
        value={displayText}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />
      {selected && !open && (
        <span
          onClick={() => !disabled && onChange("")}
          title="Clear selection"
          style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", cursor: "pointer", color: "#94a3b8" }}
        >×</span>
      )}
      {open && (
        <div
          style={{
            position: "absolute", zIndex: 20, top: "calc(100% + 4px)", left: 0, right: 0,
            maxHeight: 280, overflowY: "auto", background: "var(--card-bg, #0f172a)",
            border: "1px solid var(--border, rgba(148,163,184,0.3))", borderRadius: 8,
            boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
          }}
        >
          {filtered.length === 0 ? (
            <div style={{ padding: "10px 12px", fontSize: 13, color: "#94a3b8" }}>No matching driver groups.</div>
          ) : (
            filtered.slice(0, 100).map((o, i) => (
              <div
                key={o.groupId}
                onMouseDown={(e) => { e.preventDefault(); choose(o); }}
                onMouseEnter={() => setHighlight(i)}
                style={{
                  padding: "8px 12px", fontSize: 13, cursor: "pointer",
                  background: i === highlight ? "rgba(59,130,246,0.18)" : "transparent",
                  color: o.groupId === Number(value) ? "#60a5fa" : "inherit",
                }}
              >
                {o.label}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
