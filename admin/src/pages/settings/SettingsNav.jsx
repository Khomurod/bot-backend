import React from "react";
import { SETTINGS_GROUPS } from "./sections";

/**
 * The Settings page's own navigation: every section, under its group.
 *
 * On a desktop it is a list beside the section; on a phone the same choice is
 * one native picker, so thirteen sections do not push the section itself a
 * screen down. Both are rendered and CSS shows one (13-settings.css); both
 * report the chosen key to the page, which owns it.
 */
export default function SettingsNav({ value, onChange }) {
  return (
    <>
      <nav className="settings-nav" aria-label="Settings sections">
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
