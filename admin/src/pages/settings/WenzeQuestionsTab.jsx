import React from "react";

import LessonsCard from "./ai/LessonsCard";
import ControlChannelCard from "./control/ControlChannelCard";
import useAiSettings, { AiLoading, AiStatus } from "./ai/useAiSettings";

/**
 * Settings → AI → Wenze's Questions (`#settings/ai_questions`): how Wenze asks
 * a person in Telegram, and what it keeps from the answers.
 *
 * Two cards that were on two screens until November 2026, both "Wenze asks in
 * the notifications group, a person replies":
 *
 *   - What Wenze learned from you (was under AI & Autonomy): when the AI is
 *     still unsure, ask, and keep the answer in the person's own words.
 *     docs/architecture/ai-learning.md.
 *   - Answering Wenze in Telegram (was under Notifications): when Wenze could
 *     fix something it has not been told it may, ask yes / no / later — and
 *     WHO it obeys. docs/architecture/control-channel.md.
 *
 * They stay two cards with their own saves; only the screen is shared. Both
 * report into this section's banner, so "Saved." appears next to them.
 */
export default function WenzeQuestionsTab() {
  const { data, status, flash, saveSettings } = useAiSettings();
  return (
    <div>
      <p style={{ color: "var(--text-muted)", marginTop: 0 }}>
        Wenze asks in the notifications group when it is not sure, or when it could fix something
        it has not been allowed to. Reply to its message in plain words.
      </p>
      <AiStatus status={status} />
      {data ? (
        <LessonsCard
          learningEnabled={data.settings.learningEnabled}
          onToggle={(on) => saveSettings({ learningEnabled: on })}
          flash={flash}
        />
      ) : <AiLoading />}
      <ControlChannelCard flash={flash} />
    </div>
  );
}
