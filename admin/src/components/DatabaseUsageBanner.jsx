import React, { useCallback, useEffect, useState } from "react";
import * as api from "../api";
import useVisibleInterval from "../utils/useVisibleInterval";

/**
 * "You are at 90% of this month's database transfer allowance."
 *
 * WHY IT EXISTS. The deployment reached 4.222 GB of a 5 GB monthly allowance
 * with nothing in the app aware of it, and exhausting that allowance is not a
 * graceful degradation — reads simply start failing. This is the early warning:
 * it appears at 80%, sharpens at 90% and 95%, and stays out of the way below
 * that.
 *
 * IT IS AN ESTIMATE AND SAYS SO. The server samples result sizes rather than
 * asking the provider, so the wording points at the provider dashboard for the
 * billed figure. Claiming precision it does not have would be worse than
 * silence.
 *
 * IT COSTS ALMOST NOTHING TO SHOW. The endpoint reads in-memory counters and
 * performs no database query, and this polls it every 15 minutes, only while
 * the tab is visible. A meter that consumed the allowance it measures would be
 * self-defeating.
 *
 * AND IT MUST NEVER THROW. This is the ONE component App renders outside
 * `PageErrorBoundary` — it sits above the page so it shows on every section —
 * so a render error here is not caught by anything and React unmounts the whole
 * admin panel. A blank page, from the warning banner. That is the same shape as
 * the incident PageErrorBoundary was written for, with no boundary left to
 * contain it.
 *
 * A failed FETCH was always handled. A malformed ANSWER was not: the body below
 * calls `usage.queries.toLocaleString()`, which throws on a 200 whose payload is
 * not the object this expects — a proxy's error page, a half-deployed server, a
 * shape change on the other side. `usable()` is why that is now a silent
 * no-render instead. A banner is not worth an error of its own, and it is
 * certainly not worth the panel.
 *
 * AND IT NAMES WHAT IS SPENDING IT. "You are at 90%" is an alarm with nothing
 * in it to act on; "90%, and 61% of that is reading group_messages" is the same
 * alarm and a place to start. The breakdown is read defensively for the same
 * reason as everything else here — an older server sends no `breakdown`, and
 * the banner must still show.
 */
const REFRESH_MS = 15 * 60 * 1000;

const LEVEL_STYLE = {
  warning: { color: "#f59e0b", label: "Heads up" },
  high: { color: "#f97316", label: "Warning" },
  critical: { color: "#ef4444", label: "Critical" },
};

/**
 * Every field the body below renders, present and of the right kind.
 *
 * Deliberately a whitelist of what is USED rather than a type check of what is
 * sent: a new field on the server must not make the banner vanish, and a
 * missing one must not make it throw.
 */
function usable(usage) {
  if (!usage || typeof usage !== "object") return false;
  if (typeof usage.level !== "string") return false;
  return (
    Number.isFinite(Number(usage.percent))
    && Number.isFinite(Number(usage.gigabytes))
    && Number.isFinite(Number(usage.budgetGigabytes))
    && Number.isFinite(Number(usage.queries))
    && typeof usage.monthKey === "string"
  );
}

export default function DatabaseUsageBanner() {
  const [usage, setUsage] = useState(null);
  const [dismissedAt, setDismissedAt] = useState(null);

  const load = useCallback(async () => {
    try {
      setUsage(await api.getDatabaseUsage());
    } catch (err) {
      // A banner is not worth an error of its own: if diagnostics are
      // unavailable, every other section still says what is wrong.
      setUsage(null);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useVisibleInterval(load, REFRESH_MS);

  if (!usable(usage) || usage.level === "ok") return null;
  // Dismissal holds until the situation gets worse, then speaks up again.
  if (dismissedAt === usage.level) return null;

  const style = LEVEL_STYLE[usage.level] || LEVEL_STYLE.warning;
  // Defensive on purpose: a server that predates the breakdown sends none, and
  // a banner that vanished because of a missing diagnostic would be worse than
  // one without it.
  const tables = Array.isArray(usage.breakdown?.tables)
    ? usage.breakdown.tables.filter((t) => t && typeof t.label === "string").slice(0, 3)
    : [];

  return (
    <div
      role="status"
      className="card"
      style={{ borderLeft: `4px solid ${style.color}`, marginBottom: 16, padding: "12px 16px" }}
    >
      <div style={{ display: "flex", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 260 }}>
          <strong>{style.label}: about {usage.percent}% of this month's database transfer allowance</strong>
          <div style={{ fontSize: 13, marginTop: 4 }}>
            Roughly {usage.gigabytes} GB of {usage.budgetGigabytes} GB used in {usage.monthKey}, across{" "}
            {Number(usage.queries).toLocaleString()} queries. Going over does not fail gracefully — database reads
            start failing — so it is worth closing dashboards nobody is watching and avoiding bulk exports
            until the month resets.
          </div>
          {tables.length > 0 && (
            <div style={{ fontSize: 13, marginTop: 6 }}>
              Reading most since this server started:{" "}
              {tables.map((t, i) => (
                <span key={t.label}>
                  {i > 0 ? ", " : ""}
                  <strong>{t.label}</strong>
                  {Number.isFinite(Number(t.share)) ? ` (${Math.round(Number(t.share) * 100)}%)` : ""}
                </span>
              ))}
              .
            </div>
          )}
          <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}>
            This is an estimate measured by this app, not a bill. Check the database provider's dashboard
            for the official figure. The table list covers only what this server has read since it last
            restarted, so it shows the shape of the spending rather than the month's total.
          </div>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={() => setDismissedAt(usage.level)}>
          Dismiss
        </button>
      </div>
    </div>
  );
}
