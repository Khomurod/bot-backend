import React, { useCallback, useEffect, useState } from "react";
import * as api from "../../api";
import { Banner } from "./fields";
import RecruiterCard from "./ringcentral/RecruiterCard";
import InviteRecruiterPanel from "./ringcentral/InviteRecruiterPanel";
import AddRecruiterPanel from "./ringcentral/AddRecruiterPanel";
import PageFailure from "../../components/PageFailure";

/**
 * Settings → Recruiters & Numbers (`#settings/ringcentral`): each recruiter's
 * own identity — their number, their RingCentral sign-in, and which Bitrix24
 * user they are. That mapping is what makes a Facebook lead go out from the
 * assigned recruiter's number instead of the shared company line, so a
 * recruiter with no sign-in or no Bitrix id is shown as such on their row
 * rather than looking configured.
 *
 * THE LIST COMES FIRST (November 2026). This was the last of six cards on the
 * "RingCentral & Bitrix24" screen, below the credentials, the KPI targets, the
 * Bitrix24 connection and two always-open add forms. The forms now open from
 * buttons; the credentials are RingCentral Connection, Bitrix24 its own
 * section, and the targets Recruiter KPIs → Targets. The section keeps the
 * `ringcentral` address, so old links still open the recruiters.
 *
 * When the recruiters cannot be read, it says so with a retry INSTEAD of an
 * empty list that would look like "no recruiters".
 */
export default function RecruitersTab() {
  const [recruiters, setRecruiters] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [message, setMessage] = useState(null);
  const [open, setOpen] = useState(null); // "invite" | "add" | null

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const recs = await api.getRecruiters();
      if (!Array.isArray(recs)) throw new Error("The server did not send the recruiters.");
      setRecruiters(recs);
    } catch (err) {
      setLoadError(err);
      setRecruiters(null);
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const refreshRecruiters = useCallback(async () => {
    setRecruiters(await api.getRecruiters());
  }, []);

  // The Bitrix user directory, fetched at most once per visit and shared by
  // every recruiter row's picker — each card asking for its own copy would be
  // one Bitrix REST call per open card.
  const [bitrixUsers, setBitrixUsers] = useState(null);
  // Returns the users, or null when the directory could not be read at all —
  // the caller must not mistake "Bitrix refused" for "the portal is empty".
  const loadBitrixUsers = useCallback(async () => {
    if (bitrixUsers) return bitrixUsers;
    let res;
    try {
      res = await api.getBitrixUsers();
    } catch (err) {
      setMessage({ type: "error", text: `Bitrix user directory: ${err.message}` });
      return null;
    }
    if (!res?.ok) {
      setMessage({ type: "error", text: res?.message || "Could not read the Bitrix user directory." });
      return null;
    }
    const users = res.users || [];
    setBitrixUsers(users);
    return users;
  }, [bitrixUsers]);

  const toggle = (which) => setOpen((cur) => (cur === which ? null : which));

  if (loading) return <div className="loading"><div className="spinner"></div> Loading…</div>;
  if (!recruiters) return <PageFailure error={loadError} where="the recruiters" onRetry={load} />;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
        <p style={{ color: "var(--text-muted)", marginTop: 0, flex: "1 1 320px" }}>
          A row that says <strong>Sends as self</strong> and carries a <strong>Bitrix #</strong> texts
          its own leads; anything else falls back to the shared company number. The shared
          credentials are under <a href="#settings/rc_connection">RingCentral Connection</a>.
        </p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button type="button" className={`btn btn-sm ${open === "invite" ? "btn-primary" : "btn-ghost"}`} aria-expanded={open === "invite"} onClick={() => toggle("invite")}>
            Invite a recruiter
          </button>
          <button type="button" className={`btn btn-sm ${open === "add" ? "btn-primary" : "btn-ghost"}`} aria-expanded={open === "add"} onClick={() => toggle("add")}>
            Add manually
          </button>
        </div>
      </div>
      <Banner message={message} />

      {open === "invite" && <InviteRecruiterPanel onMessage={setMessage} />}
      {open === "add" && <AddRecruiterPanel onAdded={refreshRecruiters} onMessage={setMessage} />}

      <h3 style={{ margin: "12px 0 4px" }}>Recruiters &amp; Assigned Numbers</h3>
      <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 0 }}>
        <strong>Test connection</strong> is a quick check, <strong>Diagnose</strong> a step-by-step
        report (credentials → auth → number match → SMS capability → call log), and{" "}
        <strong>Send test SMS</strong> proves a row end to end.
      </p>
      {recruiters.length === 0 ? (
        <div className="card"><div style={{ fontSize: 13, color: "var(--text-muted)" }}>No recruiters yet. Invite one, or add one manually.</div></div>
      ) : (
        recruiters.map((r) => (
          <RecruiterCard
            key={r.id}
            recruiter={r}
            onSaved={refreshRecruiters}
            onDeleted={refreshRecruiters}
            onMessage={setMessage}
            bitrixUsers={bitrixUsers}
            loadBitrixUsers={loadBitrixUsers}
          />
        ))
      )}
    </div>
  );
}
