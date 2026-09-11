import React, { useCallback, useEffect, useState } from "react";

import * as api from "../../api";

/**
 * The one thing that must not be quiet.
 *
 * WITH NO TELEGRAM DESTINATION SET, every operational notice is discarded at the
 * door. That is the right behaviour — enqueuing them would mean that on the day
 * somebody finally configures a group, months of stale alerts flood a live staff
 * chat, which this repository explicitly decided not to do with 98 expired
 * home-time alerts. But the COST of that decision was invisible: every
 * background feature running, finding real things, and saying nothing.
 *
 * That is the exact silence the whole project started from. A hundred and one
 * staff alerts were discarded for months because a minus sign was dropped, and
 * nothing ever told a human. The replacement had reproduced the same silence by
 * a different route, behind a grey "not configured" note on a settings page
 * nobody has a reason to open.
 *
 * So it is stated here, on the page an operator actually lives on, WITH THE
 * NUMBER. "Not configured" is a sentence people scroll past. "1,247 alerts have
 * been thrown away" is not.
 *
 * It renders NOTHING when a destination is set — a banner that is always there
 * is a banner nobody sees.
 */
export default function ConfigurationBanner() {
  const [missing, setMissing] = useState(null);

  const load = useCallback(async () => {
    try {
      const { components = [] } = await api.getSystems();
      // Only the configuration gaps. A failing worker belongs in the tab, not
      // in a banner over every other screen.
      setMissing(components.filter((c) => (
        c.state === "needs_human_attention" && c.group === "integration" && c.critical
      )));
    } catch (_) {
      // Silent: a banner that cannot load its own reason must not replace the
      // page with an error. The Systems tab reports the failure properly.
      setMissing(null);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (!missing || missing.length === 0) return null;

  return (
    <div
      role="status"
      style={{
        border: "1px solid #dc2626",
        background: "rgba(220,38,38,0.08)",
        borderRadius: 8,
        padding: "10px 12px",
        marginBottom: 14,
      }}
    >
      <strong>Wenze cannot tell anybody what it finds.</strong>
      <ul style={{ margin: "6px 0 0", paddingLeft: 20 }}>
        {missing.map((c) => (
          <li key={c.component} style={{ fontSize: 13 }}>
            <strong>{c.label}</strong> — {c.reason}
          </li>
        ))}
      </ul>
    </div>
  );
}
