import React, { useCallback, useEffect, useState } from "react";
import * as api from "../../api";
import { when, DOCUMENT_STATUS, REVIEW_REASON, money } from "./format";

/**
 * The attachments, and what Wenze made of each.
 *
 * "COULD NOT FETCH" AND "NEEDS A PERSON" ARE DIFFERENT ROWS AND DIFFERENT
 * BUTTONS. Only the first is retryable — running the same reader over the same
 * bytes reaches the same place, so offering a retry on a `needs_review` would
 * be a button that does nothing and looks like it should.
 *
 * It opens on the ones needing a person, because that is the list somebody
 * came here to work through.
 */
export default function DocumentsTab() {
  const [status, setStatus] = useState("needs_review");
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState(null);
  const [note, setNote] = useState(null);

  const load = useCallback(async (which) => {
    setLoading(true);
    try {
      const d = await api.listFinanceDocuments(which === "all" ? null : which);
      setRows(d.documents || []);
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(status); }, [load, status]);

  const retry = async (id) => {
    setBusyId(id); setNote(null);
    try {
      await api.retryFinanceDocument(id);
      setNote("Queued again. It will be read within a few minutes.");
      await load(status);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusyId(null);
    }
  };

  const retryable = (s) => ["failed", "skipped_too_large", "skipped_unsupported"].includes(s);

  return (
    <div>
      <div className="ios-glass ai-tab-bar" style={{ marginBottom: 14 }}>
        {["needs_review", "failed", "read", "pending", "all"].map((k) => (
          <button
            key={k}
            className={`btn ${status === k ? "btn-primary" : "btn-ghost"} touch-target`}
            onClick={() => setStatus(k)}
          >
            {k === "all" ? "Everything" : DOCUMENT_STATUS[k]}
          </button>
        ))}
      </div>

      {note && <div className="alert alert-success">{note}</div>}
      {error && <div className="alert alert-error">{error}</div>}

      {loading ? (
        <div className="loading"><div className="spinner"></div> Loading…</div>
      ) : rows.length === 0 ? (
        <div className="muted">Nothing here.</div>
      ) : (
        <table className="data-table">
          <thead>
            <tr><th>Arrived</th><th>File</th><th>State</th><th>Read</th><th></th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td style={{ whiteSpace: "nowrap" }}>{when(r.createdAt)}</td>
                <td>
                  {r.fileName || (r.kind === "photo" ? "a photo" : "a document")}
                  {r.caption && <div className="muted" style={{ fontSize: 12 }}>{r.caption}</div>}
                </td>
                <td>
                  {DOCUMENT_STATUS[r.status] || r.status}
                  {r.reviewReason && (
                    <div className="muted" style={{ fontSize: 12 }}>
                      {REVIEW_REASON[r.reviewReason] || r.reviewReason}
                    </div>
                  )}
                  {r.lastError && (
                    <div className="muted" style={{ fontSize: 12 }}>{r.lastError}</div>
                  )}
                </td>
                <td>
                  {r.extracted
                    ? [
                      r.extracted.amount ? money(r.extracted.amount, r.extracted.currency) : null,
                      r.extracted.issuedAt,
                      r.extracted.code,
                    ].filter(Boolean).join(" · ") || "—"
                    : "—"}
                </td>
                <td>
                  {retryable(r.status) ? (
                    <button
                      className="btn btn-ghost touch-target"
                      disabled={busyId === r.id}
                      onClick={() => retry(r.id)}
                    >
                      {busyId === r.id ? "Queuing…" : "Try again"}
                    </button>
                  ) : (
                    <span className="muted" style={{ fontSize: 12 }}>
                      {r.status === "needs_review" ? "open it in Telegram" : ""}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
