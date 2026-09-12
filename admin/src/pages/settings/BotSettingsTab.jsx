import React, { Suspense, lazy, useState } from "react";
import PageErrorBoundary from "../../components/PageErrorBoundary";

/**
 * Settings → Bot Settings: how the bot behaves in the chats it is already in.
 *
 * These two were top-level sidebar entries, filed under a section called
 * "Team" between Driver Raises and Driver Home Time — a reaction-emoji rule and
 * a read-access audit sitting among the screens about paying drivers. Neither
 * is an integration (nothing to authenticate) and neither is a destination, so
 * they are here: the settings that are about the bot itself.
 *
 * TWO PANELS, ONE AT A TIME, EACH LAZY. Stacking them would be ~650 lines and
 * two independent loads — Bot Group Access lists every driver group and probes
 * what the bot can read — on every visit, when a person came for one of them.
 * Same reason Communications does it, and the panels keep their own error
 * boundary for the same reason too: one failing must not take the switch down
 * with it, or there is no way to reach the other without leaving Settings.
 */

const AutoReactionsPanel = lazy(() => import("./bot/AutoReactionsPanel"));
const GroupAccessPanel = lazy(() => import("./bot/GroupAccessPanel"));

const PANELS = [
  { key: "reactions", icon: "😀", label: "Auto Reactions", Component: AutoReactionsPanel },
  { key: "access", icon: "🔍", label: "Group Access", Component: GroupAccessPanel },
];

export default function BotSettingsTab() {
  const [panel, setPanel] = useState(PANELS[0].key);
  const active = PANELS.find((p) => p.key === panel) || PANELS[0];
  const Active = active.Component;

  return (
    <div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
        {PANELS.map((p) => (
          <button
            key={p.key}
            type="button"
            className={`btn ${panel === p.key ? "btn-primary" : "btn-ghost"} btn-sm touch-target`}
            onClick={() => setPanel(p.key)}
          >
            {p.icon} {p.label}
          </button>
        ))}
      </div>
      <PageErrorBoundary resetKey={active.key}>
        <Suspense fallback={<div style={{ padding: 20, color: "#94a3b8" }}>Loading…</div>}>
          <Active />
        </Suspense>
      </PageErrorBoundary>
    </div>
  );
}
