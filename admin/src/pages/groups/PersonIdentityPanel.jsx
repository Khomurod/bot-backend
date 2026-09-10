import React from "react";

import * as api from "../../api";

/**
 * Who this driver IS, above the chat: every group they have held and every
 * truck, in time. Read-only. Empty state says so plainly — a driver group the
 * identity layer has not met yet is a fact worth seeing, not a blank.
 */
const SOURCE_LABEL = {
  telegram_user_id: "same Telegram account",
  name_key: "returned under the same name",
  backfill: "backfill",
  bot: "first seen by the bot",
  manual: "set by an admin",
  import: "import",
  group_title: "group title",
  profile: "driver profile",
  samsara: "Samsara",
};

function when(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString();
}

function span(row) {
  const from = when(row.startedAt);
  const to = when(row.endedAt);
  if (!from) return to ? `until ${to}` : "";
  return to ? `${from} → ${to}` : `since ${from}`;
}

export default function PersonIdentityPanel({ personId }) {
  const [person, setPerson] = React.useState(null);
  const [error, setError] = React.useState(null);

  React.useEffect(() => {
    if (!personId) return undefined;
    let cancelled = false;
    api.getPersonIdentity(personId)
      .then((p) => { if (!cancelled) setPerson(p); })
      .catch((err) => { if (!cancelled) setError(err?.detail || err?.message || "Could not load."); });
    return () => { cancelled = true; };
  }, [personId]);

  const labelStyle = { fontSize: 12, color: "var(--text-muted)", marginBottom: 4, display: "block" };

  if (!personId) {
    return (
      <div>
        <label style={labelStyle}>Permanent identity</label>
        <div style={{ fontSize: 13, color: "var(--text-muted)" }}>
          Not placed yet — the next message in this group, or the identity backfill under
          Needs Attention → Identity, gives this driver a permanent record.
        </div>
      </div>
    );
  }

  return (
    <div>
      <label style={labelStyle}>Permanent identity · person #{personId}</label>
      {error && <div className="alert alert-error">{error}</div>}
      {person && (
        <div style={{ fontSize: 13, display: "grid", gap: 6 }}>
          <div>
            <b>{person.displayName}</b>
            {person.mergedFrom?.length > 0 && (
              <span style={{ color: "var(--text-muted)" }}>
                {" "}· also recorded as {person.mergedFrom.map((m) => m.displayName).join(", ")}
              </span>
            )}
          </div>
          <div>
            <span style={{ color: "var(--text-muted)" }}>Groups:</span>
            <ul style={{ margin: "4px 0 0 16px", padding: 0 }}>
              {person.groups.map((g) => (
                <li key={g.id}>
                  {g.groupName}{g.endedAt ? "" : " (current)"}
                  {" "}<span style={{ color: "var(--text-muted)" }}>
                    {span(g)} · {SOURCE_LABEL[g.associationSource] || g.associationSource}
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <span style={{ color: "var(--text-muted)" }}>Trucks:</span>
            {person.units.length === 0 ? (
              <span> none recorded</span>
            ) : (
              <ul style={{ margin: "4px 0 0 16px", padding: 0 }}>
                {person.units.map((u) => (
                  <li key={u.id}>
                    Unit <code>{u.unitNumber}</code>{u.endedAt ? "" : " (current)"}
                    {" "}<span style={{ color: "var(--text-muted)" }}>{span(u)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
