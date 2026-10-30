import React from "react";

import * as api from "../../../api";
import { relativeTime } from "../format";
import SurveyResponses from "./SurveyResponses";

function surveyText(question) {
  if (question.text_en) return question.text_en;
  if (!Array.isArray(question.translations)) return "(no survey text)";
  const en = question.translations.find((t) => t && t.language === "en");
  const fallback = question.translations.find((t) => t && typeof t.question_text === "string");
  return (en && en.question_text) || (fallback && fallback.question_text) || "(no survey text)";
}

function statusOf(question) {
  if (question.active === false) return { cls: "status-pill--neutral", text: "Closed" };
  if (question.last_sent_at) {
    const groups = Number(question.last_sent_groups) || 0;
    return { cls: "status-pill--success", text: `Sent ${relativeTime(question.last_sent_at)} · ${groups} ${groups === 1 ? "group" : "groups"}` };
  }
  // Sent before the app remembered sends (migration 0089): answers prove it went out.
  if (Number(question.response_count) > 0) return { cls: "status-pill--success", text: "Sent earlier" };
  return { cls: "status-pill--warning", text: "Not sent yet" };
}

/**
 * One survey: its English text, whether it went out, how many drivers
 * answered, and the two things a person may do with it.
 *
 * SEND goes to every ACTIVE driver group, each in its own language — real
 * messages to real drivers — so it names the number of groups and asks first,
 * and says so again when the survey already went out (a driver who answered
 * cannot answer twice; the others get a second message). CLOSE stops it for
 * good: it can no longer be sent, and a driver who taps an answer afterwards is
 * told it is closed. Answers already given stay.
 */
export default function SurveyCard({ question, expanded, onToggle, onChanged }) {
  const [busy, setBusy] = React.useState(null);
  const [result, setResult] = React.useState(null);
  const [error, setError] = React.useState(null);
  const closed = question.active === false;
  const status = statusOf(question);
  const answers = Number(question.response_count) || 0;
  const sentBefore = Boolean(question.last_sent_at) || answers > 0;

  const send = async () => {
    setError(null);
    setResult(null);
    setBusy("send");
    try {
      const groups = await api.getGroupsManage();
      const count = groups.filter((g) => g.active !== false).length;
      if (count === 0) { setError("There are no active driver groups to send it to."); return; }
      const again = sentBefore
        ? ` It already went out${question.last_sent_at ? ` ${relativeTime(question.last_sent_at)}` : ""}; drivers who answered cannot answer again.`
        : "";
      if (!window.confirm(`Send this survey to ${count} active driver ${count === 1 ? "group" : "groups"}, each in its own language?${again}`)) return;
      const outcome = await api.sendQuestion(question.id);
      setResult(outcome);
      onChanged();
    } catch (err) {
      setError(err?.message || "Could not send the survey.");
    } finally {
      setBusy(null);
    }
  };

  const close = async () => {
    if (!window.confirm("Close this survey? It can no longer be sent, and a driver who taps an answer from now on is told it is closed. Answers already given stay.")) return;
    setError(null);
    setBusy("close");
    try {
      await api.deactivateQuestion(question.id);
      onChanged();
    } catch (err) {
      setError(err?.message || "Could not close the survey.");
    } finally {
      setBusy(null);
    }
  };

  const delivered = Number(result?.sent) || 0;
  const failed = Number(result?.failed) || 0;
  const unreachable = (result?.errors || []).map((e) => e.group).filter(Boolean);
  const named = unreachable.length > 5
    ? `${unreachable.slice(0, 5).join(", ")} and ${unreachable.length - 5} more`
    : unreachable.join(", ") || "see the server log";
  return (
    <div className="card question-card" style={{ marginBottom: 12 }}>
      <div className="question-header" style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div className="question-info" style={{ minWidth: 0 }}>
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Created {relativeTime(question.created_at)}</span>
          <h3 style={{ margin: "4px 0 0" }}>{surveyText(question)}</h3>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span className={`status-pill ${status.cls}`}>{status.text}</span>
          <span className={`status-pill ${answers > 0 ? "status-pill--success" : "status-pill--neutral"}`}>
            {answers} {answers === 1 ? "answer" : "answers"}
          </span>
        </div>
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
        <button type="button" className="btn btn-secondary btn-sm" aria-expanded={expanded} onClick={onToggle}>
          {expanded ? "Hide answers" : "Show answers"}
        </button>
        {!closed && (
          <>
            <button type="button" className="btn btn-primary btn-sm" disabled={busy !== null} onClick={send}>
              {busy === "send" ? "Sending…" : sentBefore ? "Send again…" : "Send to driver groups…"}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" disabled={busy !== null} onClick={close}>Close survey</button>
          </>
        )}
      </div>
      {error && <div className="alert alert-error" role="alert" style={{ marginTop: 12, marginBottom: 0 }}>{error}</div>}
      {result && (
        <div className={`alert ${delivered === 0 ? "alert-error" : failed > 0 ? "alert-warning" : "alert-success"}`} role="status" style={{ marginTop: 12, marginBottom: 0 }}>
          Sent to {delivered} {delivered === 1 ? "group" : "groups"}.
          {failed > 0 && <> {failed} could not be reached: {named}.</>}
        </div>
      )}
      {expanded && <SurveyResponses questionId={question.id} />}
    </div>
  );
}
