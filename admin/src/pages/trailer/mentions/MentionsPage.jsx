import React, { useMemo, useState } from "react";
import api from "../../../api/trailerAgreements";
import dept from "../../../api/trailerDepartment";
import { Alert, Card, Empty, PageHeader, useLoad } from "../TrailerUi";
import MentionResolveDialog from "./MentionResolveDialog";

const when = (d) => (d ? new Date(d).toLocaleString() : "—");

/**
 * Unknown trailer messages: Telegram messages that mentioned a trailer number
 * not on the official list. One message at a time, the message itself first,
 * with four plain actions — link, add as new trailer (inline, permission-
 * gated), ignore, or "not a trailer message".
 */
export default function MentionsPage() {
  const list = useLoad(() => api.listMentions({ review_status: "pending" }), []);
  const assets = useLoad(() => dept.trailers(), []);
  const [resolve, setResolve] = useState(null); // { mention, action }
  const [msg, setMsg] = useState(null);
  const [cursor, setCursor] = useState(0);

  const rows = useMemo(() => list.data?.rows || [], [list.data]);
  const trailers = assets.data?.trailers || [];
  const mention = rows[Math.min(cursor, Math.max(rows.length - 1, 0))];

  const submit = async (body) => {
    const { trailer } = await api.resolveMention(resolve.mention.id, body);
    setResolve(null);
    setMsg({
      text: body.review_status === "created" && trailer
        ? `Trailer ${trailer.unit_number} added and linked.`
        : body.review_status === "linked"
          ? "Message linked to the trailer."
          : "Message resolved.",
    });
    await list.reload();
    setCursor(0);
  };

  return (
    <div>
      <PageHeader
        title="Unknown trailer messages"
        subtitle="Messages that mention a trailer number we do not recognize. Review them one by one."
      />
      <Alert message={msg} />
      {list.error && <div className="alert alert-danger">{list.error}</div>}
      {list.loading ? (
        <div className="loading"><div className="spinner" />Loading…</div>
      ) : !rows.length ? (
        <Card>
          <Empty>No unknown trailer messages to review — the queue is clear.</Empty>
        </Card>
      ) : (
        <Card>
          <p className="trailer-help">
            Message {Math.min(cursor + 1, rows.length)} of {rows.length}
          </p>
          <blockquote className="trailer-mention-message">
            {mention.message_text || "(no message text was captured)"}
          </blockquote>
          <div className="trailer-summary">
            <span>Detected number: <b>{mention.normalized_unit_number || mention.raw_unit_number || "—"}</b></span>
            <span>From: {mention.sender_name || mention.sender_username || "unknown sender"}</span>
            <span>Group: {mention.telegram_group_title || "—"}</span>
            <span>{when(mention.detected_at)}</span>
            {mention.ai_confidence != null && <span>Confidence: {mention.ai_confidence}%</span>}
          </div>
          <p>This number is not on the trailer list. What is it?</p>
          <div className="trailer-actions">
            <button type="button" className="btn btn-primary"
              onClick={() => setResolve({ mention, action: "linked" })}>
              Link to an existing trailer
            </button>
            <button type="button" className="btn btn-secondary"
              onClick={() => setResolve({ mention, action: "created" })}>
              Add as a new trailer
            </button>
            <button type="button" className="btn btn-ghost"
              onClick={() => setResolve({ mention, action: "ignored" })}>
              Ignore
            </button>
            <button type="button" className="btn btn-ghost"
              onClick={() => setResolve({ mention, action: "false_detection" })}>
              Not a trailer message
            </button>
            {rows.length > 1 && (
              <button type="button" className="btn btn-ghost"
                onClick={() => setCursor((cursor + 1) % rows.length)}>
                Skip to next message
              </button>
            )}
          </div>
        </Card>
      )}
      {resolve && (
        <MentionResolveDialog
          mention={resolve.mention}
          action={resolve.action}
          trailers={trailers}
          onClose={() => setResolve(null)}
          onSubmit={submit}
        />
      )}
    </div>
  );
}
