import React from "react";

/**
 * The clickable {first_name} / {unit_number} / … tokens.
 *
 * Clicking one inserts it at the caret of whichever language textarea last had
 * focus, so the chips do not need to know which of the six editors is active —
 * the page tracks that.
 *
 * Split out of admin/src/pages/BroadcastPage.jsx.
 */
export function PlaceholderChips({ placeholders, onInsert }) {
  if (!Array.isArray(placeholders) || placeholders.length === 0) return null;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
      {placeholders.map((p) => (
        <button
          key={p.key}
          type="button"
          className="btn btn-ghost"
          style={{ fontSize: 12, padding: '4px 10px', border: '1px solid var(--border)' }}
          title={p.description || p.label || p.key}
          onClick={() => onInsert(`{${p.key}}`)}
        >
          {`{${p.key}}`}
        </button>
      ))}
    </div>
  );
}
