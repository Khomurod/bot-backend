import React from "react";

/**
 * One line of Monitoring → Logs: When · What · Who · Why · Result.
 * Plain words; the codes stay in the evidence, never on the screen.
 */

const ACTIONS = {
  "deal.stage": "Deal stage changed",
  "deal.title": "Deal renamed",
  "deal.fields": "Deal fields changed",
  "deal.create": "Deal created",
  "contact.create": "Contact created",
  "contact.update": "Contact changed",
  "lead.create": "Lead created",
  "item.update": "Item changed",
};

const RESULT = {
  done: { label: "Done", className: "badge badge-active" },
  refused: { label: "Refused", className: "badge badge-warning" },
  failed: { label: "Failed", className: "badge badge-danger" },
  already_done: { label: "Already so", className: "badge badge-muted" },
};

const TARGET = { deal: "Deal", contact: "Contact", lead: "Lead", item: "Item" };
const SYSTEM = { bitrix: "Bitrix" };

function when(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso || "");
  return d.toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

const show = (v) => (v == null || v === "" ? "—" : String(v));

function Who({ entry, featureLabel }) {
  if (entry.actorKind === "automatic") {
    return <span>Automatic: {featureLabel(entry.trigger)}</span>;
  }
  if (entry.actorKind === "unknown") {
    return <span className="muted">Unknown — the code did not say who</span>;
  }
  const how = { person_button: "pressed a button", person_reply: "replied", admin: "admin panel" }[entry.actorKind];
  return (
    <span>
      <strong>{entry.actorName || "A person"}</strong>
      {entry.actorTelegramId && <span className="muted"> · Telegram {entry.actorTelegramId}</span>}
      <div className="muted" style={{ fontSize: 12 }}>{how}{entry.trigger ? ` · ${featureLabel(entry.trigger)}` : ""}</div>
    </span>
  );
}

export default function LogRow({ entry, featureLabel = (k) => k }) {
  const result = RESULT[entry.result] || { label: entry.result, className: "badge" };
  const target = `${TARGET[entry.targetType] || "Record"}${entry.targetId ? ` ${entry.targetId}` : ""}`;
  return (
    <tr>
      <td style={{ whiteSpace: "nowrap" }} title={String(entry.occurredAt || "")}>{when(entry.occurredAt)}</td>
      <td>
        <div>
          <span className="muted">{SYSTEM[entry.system] || entry.system} · </span>
          {ACTIONS[entry.action] || entry.action}
        </div>
        <div>
          {entry.link
            ? <a href={entry.link} target="_blank" rel="noopener noreferrer">{target}</a>
            : target}
          {entry.targetLabel && <span className="muted"> · {entry.targetLabel}</span>}
        </div>
        {(entry.change || []).length > 0 && (
          <ul style={{ margin: "4px 0 0", paddingLeft: 16 }}>
            {entry.change.map((c, i) => (
              <li key={`${c.field}-${i}`}>{c.field}: {show(c.from)} → {show(c.to)}</li>
            ))}
          </ul>
        )}
      </td>
      <td><Who entry={entry} featureLabel={featureLabel} /></td>
      <td>
        {entry.reason || <span className="muted">—</span>}
        {entry.attempt > 1 && <div className="muted" style={{ fontSize: 12 }}>Attempt {entry.attempt}</div>}
      </td>
      <td>
        <span className={result.className}>{result.label}</span>
        {entry.safetyCheck && (
          <div className="muted" style={{ fontSize: 12, marginTop: 4, maxWidth: 280 }}>
            Stopped by Wenze&apos;s own safety check — nothing was sent to Bitrix.
          </div>
        )}
        {entry.error && <div className="muted" style={{ fontSize: 12, marginTop: 4, maxWidth: 280 }}>{entry.error}</div>}
      </td>
    </tr>
  );
}
