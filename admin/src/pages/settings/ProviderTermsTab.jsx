import React from "react";

import PolicyWatcherCard from "./ai/PolicyWatcherCard";
import useAiSettings, { AiLoading, AiStatus } from "./ai/useAiSettings";

/**
 * Settings → AI → Provider Terms (`#settings/ai_terms`): the watcher that reads
 * each enabled provider's own terms pages and reports a real change.
 *
 * Its own section since November 2026 (it was the last card of AI & Autonomy,
 * six screens down). It needs the provider list, to offer a provider when a
 * page is added by hand, so it reads the AI settings itself.
 */
export default function ProviderTermsTab() {
  const { data, status, flash, loadFailed, retry } = useAiSettings();
  return (
    <div>
      <AiStatus status={status} />
      {data ? <PolicyWatcherCard providers={data.providers} flash={flash} /> : <AiLoading failed={loadFailed} onRetry={retry} />}
    </div>
  );
}
