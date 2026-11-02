import React from "react";
import SystemsTab from "./operations/SystemsTab";

/**
 * Monitoring → System Health: whether every background job is actually
 * running — not what it found, which is Needs Attention's job.
 *
 * Its own page since October 2026. It was the "What is running" tab of Needs
 * Attention with a second sidebar entry onto it, so the page that answered "is
 * everything running?" showed Needs Attention's title and six unrelated tabs.
 * The screen itself is ./operations/SystemsTab.jsx. "Nobody would be told" is
 * the most important thing a health page can say, so it is the loudest line of
 * the "Needs a look" section there. Until November 2026 the banner that says it
 * on Needs Attention was also drawn here, above the very rows it repeated.
 */
export default function SystemHealthPage() {
  const [status, setStatus] = React.useState(null);
  const flash = React.useCallback((type, text) => setStatus({ type, text }), []);
  return (
    <div>
      <div className="page-header">
        <h2>System Health</h2>
        <p>
          Every background job and whether it is actually running. A job that finds
          nothing and a job that has stopped look the same everywhere else; here
          they do not.
        </p>
      </div>
      {status && (
        <div className={`alert alert-${status.type}`} style={{ marginBottom: 12 }}>{status.text}</div>
      )}
      <SystemsTab flash={flash} />
    </div>
  );
}
