import React from "react";

import ResponsibilitiesCard from "./ai/ResponsibilitiesCard";
import { AiStatus } from "./ai/useAiSettings";

/**
 * Settings → AI → AI Tasks (`#settings/ai_tasks`): every decision Wenze may use
 * AI for, each with its own switch.
 *
 * Its own section since November 2026. On the old AI & Autonomy screen these
 * seventeen cards sat between the provider health table and the lessons, and
 * made up most of that screen's 6.6 screens of scrolling.
 */
export default function AiTasksTab() {
  const [status, setStatus] = React.useState(null);
  const flash = React.useCallback((type, text) => setStatus({ type, text }), []);
  return (
    <div>
      <AiStatus status={status} />
      <ResponsibilitiesCard flash={flash} />
    </div>
  );
}
