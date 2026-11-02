import React from "react";
import { SETTINGS_GROUPS } from "./sections";

/**
 * Whether the active item can be seen: inside the nav's own scroll box AND
 * inside the window. Until the page is scrolled the nav is not stuck yet, so
 * its lower end can be below the window even when the list fits itself. PURE.
 */
export function itemIsVisible(item, box, windowHeight) {
  const SUBPIXEL = 1; // edges land on fractions of a pixel; that is not hidden
  return item.top >= Math.max(box.top, 0) - SUBPIXEL
    && item.bottom <= Math.min(box.bottom, windowHeight) + SUBPIXEL;
}

/**
 * The Settings page's own navigation: every section, under its group.
 *
 * On a desktop it is a list beside the section; on a phone the same choice is
 * one native picker, so thirteen sections do not push the section itself a
 * screen down. Both are rendered and CSS shows one (13-settings.css); both
 * report the chosen key to the page, which owns it.
 */
export default function SettingsNav({ value, onChange }) {
  const navRef = React.useRef(null);
  // A section opened by its address can be one the list shows out of sight
  // (it scrolls inside itself on a short screen). Bring the active item into
  // view, by the least scrolling that does it; a click leaves things alone,
  // because the item clicked is already in view.
  React.useEffect(() => {
    const nav = navRef.current;
    const item = nav?.querySelector('[aria-current="page"]');
    if (!item || typeof item.scrollIntoView !== "function") return;
    if (itemIsVisible(item.getBoundingClientRect(), nav.getBoundingClientRect(), window.innerHeight)) return;
    item.scrollIntoView({ block: "nearest" });
  }, [value]);

  return (
    <>
      <nav ref={navRef} className="settings-nav" aria-label="Settings sections">
        {SETTINGS_GROUPS.map((group) => (
          <div key={group.label} className="settings-nav-group">
            <div className="settings-nav-heading">{group.label}</div>
            {group.sections.map((section) => (
              <button
                key={section.key}
                type="button"
                className={`settings-nav-item ${value === section.key ? "is-active" : ""}`}
                aria-current={value === section.key ? "page" : undefined}
                onClick={() => onChange(section.key)}
              >
                {section.label}
              </button>
            ))}
          </div>
        ))}
      </nav>
      <label className="settings-picker">
        <span>Section</span>
        <select value={value} onChange={(e) => onChange(e.target.value)}>
          {SETTINGS_GROUPS.map((group) => (
            <optgroup key={group.label} label={group.label}>
              {group.sections.map((section) => (
                <option key={section.key} value={section.key}>{section.label}</option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>
    </>
  );
}
