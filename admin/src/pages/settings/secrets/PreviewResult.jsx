import React from "react";
import { scopeLabel } from "./scopes";

function NameList({ title, items, tone }) {
  if (!items.length) return null;
  return (
    <div style={{ marginBottom: 8 }}>
      <strong style={tone ? { color: `var(--${tone})` } : undefined}>{title} ({items.length})</strong>
      <ul style={{ margin: "4px 0 0 18px" }}>
        {items.map((c) => (
          <li key={`${c.scope || ""}:${c.name}`}>
            <code>{c.name}</code>
            {c.scope ? <span style={{ color: "var(--text-secondary)" }}> — {scopeLabel(c.scope)}</span> : null}
            {c.reason ? <span style={{ color: "var(--text-secondary)" }}> — {c.reason}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * What a .env file would change — names only, never a value (the server never
 * sends one). Blocking problems are listed first: while there is one, Save
 * stays disabled.
 */
export default function PreviewResult({ preview }) {
  const nothing = !preview.added.length && !preview.changed.length && !preview.removed.length;
  return (
    <div className="card" style={{ background: "var(--bg-secondary)", marginTop: 12 }} role="status">
      {preview.blocking.length > 0 && (
        <div className="alert alert-error" style={{ marginBottom: 12 }}>
          <strong>Cannot save yet:</strong>
          <ul style={{ margin: "4px 0 0 18px" }}>
            {preview.blocking.map((b) => <li key={b}>{b}</li>)}
          </ul>
        </div>
      )}
      {preview.warnings.length > 0 && (
        <div className="alert alert-warning" style={{ marginBottom: 12 }}>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {preview.warnings.map((w) => <li key={w}>{w}</li>)}
          </ul>
        </div>
      )}
      {nothing && preview.blocking.length === 0 && <p style={{ marginTop: 0 }}>Nothing would change — the file matches what is stored.</p>}
      <NameList title="New" items={preview.added} tone="success" />
      <NameList title="Changed" items={preview.changed} tone="warning" />
      <NameList title="Removed (not in the file)" items={preview.removed} tone="danger" />
      <NameList title="Not stored" items={preview.skipped} />
      {preview.duplicates.length > 0 && (
        <p style={{ margin: "0 0 8px" }}>
          Given more than once (the last line is used): {preview.duplicates.map((d) => <code key={d} style={{ marginRight: 6 }}>{d}</code>)}
        </p>
      )}
      {preview.tokens.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          <strong>Telegram tokens checked</strong>
          <ul style={{ margin: "4px 0 0 18px" }}>
            {preview.tokens.map((t) => (
              <li key={`${t.scope}:${t.name}`}>
                <code>{t.name}</code>: {t.ok ? <>works — {t.bot || "bot"}</> : <span style={{ color: "var(--danger)" }}>refused ({t.error})</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      <p style={{ margin: 0, color: "var(--text-secondary)" }}>
        {preview.unchanged} value(s) stay as they are.
        {preview.restartsThisApp ? " Saving restarts this app (about a minute)." : " Saving does not restart this app."}
      </p>
    </div>
  );
}
