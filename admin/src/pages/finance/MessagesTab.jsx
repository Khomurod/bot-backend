import React, { useCallback, useEffect, useState } from "react";
import * as api from "../../api";
import { when, PARSE_STATUS } from "./format";

/**
 * What the finance group actually said.
 *
 * THIS IS THE ONE SCREEN THAT SHOWS THE TEXT. Everywhere else in this feature
 * answers with counts, on purpose. Here a person reconciling money codes has
 * to see the message — and the alternative, scrolling Telegram, is the problem
 * the whole feature exists to solve.
 *
 * IT OPENS ON "Unclear", NOT ON EVERYTHING. The provisional parser is
 * tightened from exactly these two piles, and a list that opens on 4,000
 * ordinary messages hides the twenty that matter.
 *
 * "Read it again" RE-RUNS THE CURRENT PARSER over the stored text. It changes
 * no text and takes no value from this screen — which is what makes "capture
 * first, codify second" a workflow rather than a slogan.
 */
export default function MessagesTab() {
  const [status, setStatus] = useState("ambiguous");
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState(null);
  const [note, setNote] = useState(null);

  const load = useCallback(async (which) => {
    setLoading(true);
    try {
      const d = await api.listFinanceMessages(which === "all" ? null : which);
      setRows(d.messages || []);
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(status); }, [load, status]);

  const reparse = async (id) => {
    setBusyId(id); setNote(null);
    try {
      const out = await api.reparseFinanceMessage(id);
      setNote(out.before === out.after
        ? `Read again — still "${PARSE_STATUS[out.after] || out.after}".`
        : `Read again — now "${PARSE_STATUS[out.after] || out.after}".`);
      await load(status);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div>
      <div className="ios-glass ai-tab-bar" style={{ marginBottom: 14 }}>
        {["ambiguous", "unparsed", "parsed", "not_moneycode", "all"].map((k) => (
          <button
            key={k}
            className={`btn ${status === k ? "btn-primary" : "btn-ghost"} touch-target`}
            onClick={() => setStatus(k)}
          >
            {k === "all" ? "Everything" : PARSE_STATUS[k]}
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
            <tr><th>When</th><th>Posted by</th><th>Message</th><th>Read as</th><th></th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td style={{ whiteSpace: "nowrap" }}>{when(r.messageDate)}</td>
                <td>{r.senderName || "—"}</td>
                <td style={{ maxWidth: 420, whiteSpace: "pre-wrap" }}>
                  {r.text || <span className="muted">(no text — attachment only)</span>}
                  {r.telegramUrl && (
                    <>
                      {" "}
                      <a href={r.telegramUrl} target="_blank" rel="noreferrer">open in Telegram</a>
                    </>
                  )}
                </td>
                <td>{PARSE_STATUS[r.parseStatus] || r.parseStatus}</td>
                <td>
                  <button
                    className="btn btn-ghost touch-target"
                    disabled={busyId === r.id}
                    onClick={() => reparse(r.id)}
                  >
                    {busyId === r.id ? "Reading…" : "Read it again"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
