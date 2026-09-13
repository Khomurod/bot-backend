import React, { useCallback, useEffect, useState } from "react";
import * as api from "../../api";
import { money, when, REPORT_STATUS } from "./format";

/**
 * The weekly summaries that went out, and the ones that deliberately did not.
 *
 * `suppressed_backfill` IS SPELLED OUT IN WORDS. "Not sent — we were not
 * watching that week" and a genuinely quiet week are opposite answers, and
 * this table is the only place a person can tell them apart. A status code in
 * a column would technically be showing it and practically be hiding it.
 *
 * PREVIEW COMES BEFORE SEND, AND SEND ASKS TWICE. The preview reaches no chat
 * and writes no row, so it is the safe way to answer "is this worth switching
 * on". Sending puts a message in front of people, which is not something a
 * misplaced click should do — so the button becomes a confirmation first.
 *
 * THE PREVIEW IS SHOWN AS TEXT, NEVER AS HTML. The body is Telegram markup
 * built from captured payment messages; the composer escapes every dynamic
 * part, but a screen that rendered it would be trusting that escaping from the
 * other side of an API, and this is the one page whose content is written by
 * whoever can post in the finance group.
 */
export default function ReportsTab() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [preview, setPreview] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);

  const load = useCallback(async () => {
    try {
      const d = await api.listFinanceReports();
      setRows(d.reports || []);
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const showPreview = async () => {
    setBusy(true); setNote(null);
    try {
      setPreview(await api.previewFinanceReport());
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const sendNow = async () => {
    setBusy(true); setNote(null); setConfirming(false);
    try {
      const out = await api.sendFinanceReportNow();
      // A refusal is an ANSWER, not a failure: it names what is missing.
      if (!out.sent) setError(out.error || "It could not be sent.");
      else { setNote("Sent. It is listed below as sent by hand."); setError(null); await load(); }
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <div className="loading"><div className="spinner"></div> Loading…</div>;

  return (
    <div>
      <div style={{ display: "flex", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
        <button className="btn btn-ghost touch-target" onClick={showPreview} disabled={busy}>
          👁️ Preview last week's summary
        </button>
        {confirming ? (
          <>
            <button className="btn btn-primary touch-target" onClick={sendNow} disabled={busy}>
              Yes — send it to the finance group
            </button>
            <button className="btn btn-ghost touch-target" onClick={() => setConfirming(false)} disabled={busy}>
              Cancel
            </button>
          </>
        ) : (
          <button className="btn btn-ghost touch-target" onClick={() => setConfirming(true)} disabled={busy}>
            📤 Send it now
          </button>
        )}
      </div>

      {error && <div className="alert alert-error">{error}</div>}
      {note && <div className="alert alert-success">{note}</div>}

      {preview && (
        <div className="ios-glass" style={{ padding: 14, marginBottom: 16 }}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
            Week beginning {new Date(preview.periodStart).toLocaleDateString()} — nothing has been sent.
          </div>
          <pre style={{ whiteSpace: "pre-wrap", margin: 0, fontSize: 13 }}>{preview.body}</pre>
        </div>
      )}

      {rows.length === 0 ? (
        <div className="muted">No summaries have gone out yet.</div>
      ) : (
        <table className="data-table">
          <thead>
            <tr><th>Week beginning</th><th>Result</th><th>Codes</th><th>Total</th><th>Sent</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{new Date(r.periodStart).toLocaleDateString()}</td>
                <td>
                  {REPORT_STATUS[r.status] || r.status}
                  {r.error && <div className="muted" style={{ fontSize: 12 }}>{r.error}</div>}
                </td>
                <td>{r.totals?.codeCount ?? "—"}</td>
                <td>{r.totals ? money(r.totals.amountTotal) : "—"}</td>
                <td>{when(r.sentAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
