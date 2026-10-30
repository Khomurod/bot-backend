import React from "react";

import * as api from "../../../api";

/**
 * Settings → AI → "What Wenze learned from you".
 *
 * When a model is still not sure after Claude, Wenze asks the owner in the
 * notifications group — one question at a time, answered in plain words — and
 * keeps the answer as a lesson. Accounting's reasons for "Not charging" a
 * home-time violation are kept the same way. Every later prompt for that kind
 * of decision is given the lessons, in the person's own words.
 *
 * Remove takes a lesson back: it stays in the list, marked removed, and no
 * prompt is given it again. See docs/architecture/ai-learning.md.
 */
function when(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString();
}

function LessonRow({ lesson, scopes, onRemove, busy }) {
  const removed = Boolean(lesson.removedAt);
  return (
    <li style={{ marginBottom: 10, opacity: removed ? 0.55 : 1 }}>
      <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
        {scopes[lesson.scope] || lesson.scope}
        {" · "}
        {lesson.source === "accounting_reason" ? "Accounting's reason" : "Your answer"}
        {lesson.createdByName ? ` · ${lesson.createdByName}` : ""}
        {` · ${when(lesson.createdAt)}`}
        {removed ? ` · removed ${when(lesson.removedAt)}` : ""}
      </div>
      <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{lesson.about}</div>
      <div style={{ fontSize: 13 }}>“{lesson.statement}”</div>
      {lesson.understoodAs && lesson.understoodAs !== lesson.statement && (
        <div style={{ fontSize: 12, color: "var(--text-muted)" }}>Understood: {lesson.understoodAs}</div>
      )}
      {!removed && (
        <button
          type="button" className="btn btn-ghost btn-sm" disabled={busy}
          onClick={() => onRemove(lesson)}
        >
          Remove
        </button>
      )}
    </li>
  );
}

export default function LessonsCard({ learningEnabled, onToggle, flash }) {
  const [data, setData] = React.useState(null);
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    try {
      setData(await api.getAiLessons());
    } catch (err) {
      flash("error", err?.detail || err?.message || "Could not load the lessons.");
    }
  }, [flash]);

  React.useEffect(() => { load(); }, [load]);

  const remove = async (lesson) => {
    if (!window.confirm("Remove this lesson? Wenze will stop using it.")) return;
    setBusy(true);
    try {
      await api.removeAiLesson(lesson.id);
      flash("success", "Lesson removed.");
      await load();
    } catch (err) {
      flash("error", err?.detail || err?.message || "Could not remove the lesson.");
    } finally {
      setBusy(false);
    }
  };

  const skip = async () => {
    setBusy(true);
    try {
      await api.skipAiLearningQuestion();
      flash("success", "Skipped. The next question, if any, goes to the group.");
      await load();
    } catch (err) {
      flash("error", err?.detail || err?.message || "Could not skip the question.");
    } finally {
      setBusy(false);
    }
  };

  const lessons = data?.lessons || [];
  const live = lessons.filter((l) => !l.removedAt).length;
  const scopes = data?.scopes || {};

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <strong>🧠 What Wenze learned from you</strong>
      <div style={{ color: "var(--text-muted)", fontSize: 12, marginTop: 4 }}>
        When the AI is still not sure after Claude, Wenze asks you in the notifications
        group — one question at a time. Reply to it in plain words; Wenze says back what it
        understood and uses your answer from then on. Accounting&apos;s reasons for
        &quot;Not charging&quot; are kept the same way.
      </div>

      <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13, marginTop: 10 }}>
        <input
          type="checkbox" checked={learningEnabled !== false}
          onChange={(e) => onToggle(e.target.checked)}
        />
        Ask me when unsure
      </label>

      {data?.current && (
        <div style={{ marginTop: 10, fontSize: 13 }}>
          <div>Waiting for your answer in the group:</div>
          <div style={{ color: "var(--text-muted)" }}>{data.current.ask}</div>
          <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={skip}>
            Skip this question
          </button>
        </div>
      )}
      {data && (
        <div style={{ color: "var(--text-muted)", fontSize: 12, marginTop: 8 }}>
          {data.counts?.queued || 0} waiting to be asked · {data.counts?.answered || 0} answered
          · {data.counts?.skipped || 0} skipped · {live} lesson(s) in use
        </div>
      )}

      {lessons.length === 0 ? (
        <div style={{ color: "var(--text-muted)", fontSize: 13, marginTop: 10 }}>Nothing learned yet.</div>
      ) : (
        <ul style={{ marginTop: 10, paddingLeft: 18 }}>
          {lessons.map((l) => (
            <LessonRow key={l.id} lesson={l} scopes={scopes} onRemove={remove} busy={busy} />
          ))}
        </ul>
      )}
    </div>
  );
}
