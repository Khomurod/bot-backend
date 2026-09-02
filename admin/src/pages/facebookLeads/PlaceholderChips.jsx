import React from "react";

/**
 * The clickable {first_name} / {rep_name} / … tokens.
 *
 * Clicking one inserts it at the caret of whichever template last had focus,
 * which is why the page tracks a focus target rather than these chips owning
 * it — the same chip row serves every rule and the fallback.
 *
 * Split out of admin/src/pages/FacebookLeadsPage.jsx.
 */
export function PlaceholderChips({ placeholders, onInsert }) {
  if (!placeholders?.length) return null;
  return (
    <div className="placeholder-chips" style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 8 }}>
      {placeholders.map((p) => (
        <button
          key={p.key}
          type="button"
          className="btn btn-secondary"
          style={{ fontSize: 12, padding: "4px 10px" }}
          title={p.description}
          onClick={() => onInsert(`{${p.key}}`)}
        >
          {`{${p.key}}`}
        </button>
      ))}
    </div>
  );
}
