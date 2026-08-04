/**
 * Planned pickup/drop-off INSTRUCTIONS — what someone was told to do, which is
 * not the same as a completed event and never moves a trailer's status.
 */

import React, { useEffect, useState, useCallback } from "react";
import * as api from "../../api";
import { fmtTime, INSTRUCTION_STATUS_LABEL, INSTRUCTION_STATUS_COLOR } from "./trackingChrome";

// Assigned pickup/drop-off addresses that are NOT yet completed. These never
// change a trailer's confirmed status; they wait for a later message that
// confirms the physical action actually happened.
function PlannedTab({ flash }) {
  const [instructions, setInstructions] = useState(null);
  const [status, setStatus] = useState("pending");
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async () => {
    try {
      const d = await api.getTrailerPendingInstructions(status);
      setInstructions(d.instructions || []);
    } catch (err) { flash("error", err.message); setInstructions([]); }
  }, [flash, status]);
  useEffect(() => { load(); }, [load]);

  const cancel = async (id) => {
    setBusyId(id);
    try { await api.cancelTrailerPendingInstruction(id); flash("success", "Instruction cancelled."); await load(); }
    catch (err) { flash("error", err.message); }
    finally { setBusyId(null); }
  };

  if (!instructions) return <p>Loading…</p>;

  return (
    <div>
      <p style={{ color: "#94a3b8", fontSize: 13, marginTop: 0 }}>
        Planned pickup/drop-off assignments detected from driver-group messages (e.g. a trailer specialist
        sending a drop-off address). These do <strong>not</strong> change a trailer’s confirmed status — they wait
        for a later message confirming the physical pickup/drop-off actually happened.
      </p>
      <div style={{ marginBottom: 12, display: "flex", gap: 8 }}>
        {["pending", "confirmed", "all"].map((s) => (
          <button key={s} className={`btn btn-sm ${status === s ? "btn-primary" : "btn-ghost"}`} onClick={() => setStatus(s)}>
            {s[0].toUpperCase() + s.slice(1)}
          </button>
        ))}
      </div>
      {instructions.length === 0 ? (
        <div className="card" style={{ padding: 16, color: "#94a3b8", fontSize: 13 }}>No {status === "all" ? "" : status} instructions.</div>
      ) : (
        instructions.map((it) => (
          <div key={it.id} className="card" style={{ padding: 12, marginBottom: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
              <div>
                <strong style={{ fontFamily: "monospace" }}>{it.trailer_unit_number}</strong>
                <span style={{ marginLeft: 8, textTransform: "capitalize" }}>{it.planned_action}</span>
                <span style={{
                  marginLeft: 8, padding: "2px 8px", borderRadius: 10, fontSize: 12, fontWeight: 600,
                  background: (INSTRUCTION_STATUS_COLOR[it.instruction_status] || "#94a3b8") + "22",
                  color: INSTRUCTION_STATUS_COLOR[it.instruction_status] || "#94a3b8",
                }}>{INSTRUCTION_STATUS_LABEL[it.instruction_status] || it.instruction_status}</span>
                <div style={{ fontSize: 13, color: "#cbd5e1", marginTop: 4 }}>
                  📍 {it.planned_location || "—"}
                </div>
                <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 2 }}>
                  Assigned by {it.reported_by_name || it.reported_by_username || "unknown"}
                  {" · "}{fmtTime(it.instruction_created_at)}
                  {it.confirmed_event_id ? " · completion confirmed" : ""}
                </div>
              </div>
              {it.instruction_status === "pending" && (
                <button className="btn btn-ghost btn-sm" disabled={busyId === it.id} onClick={() => cancel(it.id)}>Cancel</button>
              )}
            </div>
          </div>
        ))
      )}
    </div>
  );
}


export default PlannedTab;
