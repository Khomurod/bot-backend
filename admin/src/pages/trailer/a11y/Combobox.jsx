import React, { useId, useMemo, useRef, useState } from "react";
import { filterByText } from "./comboboxFilter";
import { nextTabIndex, isActivationKey } from "./keys";

/**
 * Accessible searchable single-select combobox (§1).
 *
 * WAI-ARIA combobox with a filtered listbox popup: type to search, Arrow keys
 * to move the active option (aria-activedescendant), Enter/Space to choose,
 * Escape to close, and a clear button. Replaces the plain <select> for large
 * lists (companies, trailers) where scrolling a native dropdown is unusable.
 *
 * @param options  [{ value, label, hint? }]
 * @param value    currently selected value (or "")
 * @param onChange (value) => void
 */
export default function Combobox({
  options, value, onChange, placeholder = "Search…", label, emptyText = "No matches", disabled,
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const rootRef = useRef(null);

  const selected = options.find((o) => String(o.value) === String(value)) || null;
  const matches = useMemo(
    () => filterByText(options, query, (o) => `${o.label} ${o.hint || ""}`),
    [options, query],
  );

  const choose = (opt) => {
    if (!opt) return;
    onChange(opt.value);
    setQuery("");
    setOpen(false);
  };

  const onKeyDown = (e) => {
    if (e.key === "Escape") { setOpen(false); return; }
    if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) { setOpen(true); return; }
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End") {
      e.preventDefault();
      setActive((i) => nextTabIndex(i, matches.length, e.key));
      return;
    }
    if (isActivationKey(e.key) && open) {
      e.preventDefault();
      choose(matches[active]);
    }
  };

  return (
    <div className="trailer-combobox" ref={rootRef}
      onBlur={(e) => { if (!rootRef.current?.contains(e.relatedTarget)) setOpen(false); }}>
      {label && <span className="trailer-field-label">{label}</span>}
      <div className="trailer-combobox-control">
        <input
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && matches[active] ? `${listId}-opt-${active}` : undefined}
          aria-label={label || placeholder}
          disabled={disabled}
          value={open ? query : (selected?.label || "")}
          placeholder={selected ? selected.label : placeholder}
          onChange={(e) => { setQuery(e.target.value); setActive(0); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
        />
        {selected && !disabled && (
          <button type="button" className="btn btn-ghost btn-sm" aria-label="Clear selection"
            onClick={() => { onChange(""); setQuery(""); }}>×</button>
        )}
      </div>
      {open && (
        <ul className="trailer-combobox-list" role="listbox" id={listId}>
          {matches.length === 0 && <li className="trailer-combobox-empty" role="option" aria-disabled="true">{emptyText}</li>}
          {matches.map((o, i) => (
            <li
              key={o.value}
              id={`${listId}-opt-${i}`}
              role="option"
              aria-selected={String(o.value) === String(value)}
              className={`trailer-combobox-option ${i === active ? "active" : ""}`}
              // onMouseDown (not click) so selection fires before the input blur closes the list.
              onMouseDown={(e) => { e.preventDefault(); choose(o); }}
              onMouseEnter={() => setActive(i)}
            >
              {o.label}{o.hint ? <span className="trailer-combobox-hint"> — {o.hint}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
