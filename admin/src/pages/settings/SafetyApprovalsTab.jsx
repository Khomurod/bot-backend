import React, { useCallback, useEffect, useState } from "react";
import * as api from "../../api";
import { Banner } from "./fields";
import HiringStagesCard from "./HiringStagesCard";

/**
 * Settings → Safety Approvals.
 *
 * The bot listens quietly in the recruiting group. When one of the people
 * picked here as Safety REPLIES to a recruiter's driver post, it reads the
 * reply and posts the decision in the approvals topic: the CDL as a file,
 * Safety's PDFs, and the status, name and phone under them. A reply it cannot
 * read with certainty posts nothing.
 *
 * The switch stays disabled until the group is validated, the topic is named
 * and at least one Safety person is picked — each one missing is a way to post
 * a wrong "APPROVED" (the server refuses it too).
 */
export default function SafetyApprovalsTab() {
  const [settings, setSettings] = useState(null);
  const [members, setMembers] = useState([]);
  const [recent, setRecent] = useState([]);
  const [proposals, setProposals] = useState([]);
  const [form, setForm] = useState({ chatId: "", topic: "", extraId: "" });
  const [picked, setPicked] = useState([]);
  const [message, setMessage] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.getSafetyApprovals();
      setSettings(data.settings);
      setMembers(Array.isArray(data.members) ? data.members : []);
      setRecent(Array.isArray(data.recent) ? data.recent : []);
      setProposals(Array.isArray(data.proposals) ? data.proposals : []);
      setPicked(data.settings?.safetyUserIds || []);
      setForm({
        chatId: data.settings?.chatId || "",
        topic: data.settings?.topicId ? String(data.settings.topicId) : "",
        extraId: "",
      });
    } catch (err) {
      setMessage({ type: "error", text: err.message });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const run = async (fn) => {
    setBusy(true); setMessage(null);
    try { await fn(); } catch (err) { setMessage({ type: "error", text: err.message }); } finally { setBusy(false); }
  };

  const validate = () => run(async () => {
    const out = await api.validateSafetyApprovalChat(form.chatId);
    if (!out.ok) {
      setMessage({ type: "error", text: out.message || "That chat could not be validated." });
    } else if (out.seesEverything === false) {
      setMessage({ type: "error", text: out.message });
    } else {
      setMessage({ type: "success", text: `The bot can reach ${out.chatTitle || "that group"}. Save it to use it.` });
    }
  });

  const save = (patch, done = "Saved.") => run(async () => {
    await api.updateSafetyApprovals(patch);
    await load();
    setMessage({ type: "success", text: done });
  });

  const testPost = () => run(async () => {
    const out = await api.sendSafetyApprovalTestPost();
    setMessage(out.ok
      ? { type: "success", text: "A test message was posted in the topic. Check the group." }
      : { type: "error", text: out.message || "The test message could not be posted." });
  });

  const toggle = (id) => setPicked((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  const addExtra = () => {
    const id = form.extraId.trim();
    if (/^\d{3,19}$/.test(id) && !picked.includes(id)) setPicked((ids) => [...ids, id]);
    setForm((f) => ({ ...f, extraId: "" }));
  };

  if (loading) return <div className="loading"><div className="spinner"></div> Loading…</div>;

  const ready = Boolean(settings?.chatValidatedAt && settings?.topicId && settings?.safetyUserIds?.length);
  const known = new Set(members.map((m) => m.id));
  const people = [
    ...members,
    ...picked.filter((id) => !known.has(id)).map((id) => ({ id, name: null, username: null })),
  ];

  return (
    <div>
      <p style={{ color: "#94a3b8", marginTop: 0 }}>
        The bot listens <strong>quietly</strong> in the recruiting group and never writes in the
        conversation. When a Safety person <strong>replies</strong> to a recruiter&apos;s driver post,
        it posts the decision in the approvals topic: the CDL, Safety&apos;s PSP / MVR / CLH files, and
        APPROVED or NOT APPROVED with the driver&apos;s name and phone. If the reply is not clear, nothing
        is posted.
      </p>
      <Banner message={message} />

      <div className="card">
        <h3 style={{ marginTop: 0 }}>1. The recruiting group</h3>
        <div className="form-group">
          <label htmlFor="sa-chat-id">Telegram chat ID</label>
          <input id="sa-chat-id" className="form-input" placeholder="e.g. -1001234567890" value={form.chatId}
            onChange={(e) => setForm((f) => ({ ...f, chatId: e.target.value }))} disabled={busy} />
          <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}>
            {settings?.chatValidatedAt
              ? `Saved: ${settings.chatTitle || settings.chatId}, validated ${new Date(settings.chatValidatedAt).toLocaleString()}`
              : "Not saved yet."}{" "}
            The bot must be an admin of the group, or have privacy mode off, to see the posts.
          </div>
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button className="btn btn-ghost" onClick={validate} disabled={busy || !form.chatId.trim()}>Validate group</button>
          <button className="btn btn-primary" onClick={() => save({ chatId: form.chatId })} disabled={busy || !form.chatId.trim()}>
            Save group
          </button>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h3 style={{ marginTop: 0 }}>2. The approved / not approved topic</h3>
        <div className="form-group">
          <label htmlFor="sa-topic">Topic link or number</label>
          <input id="sa-topic" className="form-input" placeholder="https://t.me/c/1234567890/45"
            value={form.topic} onChange={(e) => setForm((f) => ({ ...f, topic: e.target.value }))} disabled={busy} />
          <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}>
            In Telegram, right-click any message in that topic → Copy Message Link, and paste it here.
          </div>
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button className="btn btn-primary" onClick={() => save({ topic: form.topic })}
            disabled={busy || !settings?.chatId}>Save topic</button>
          <button className="btn btn-ghost" onClick={testPost} disabled={busy || !settings?.topicId}>Send a test message</button>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h3 style={{ marginTop: 0 }}>3. Who is Safety</h3>
        <p style={{ color: "var(--text-muted)", marginTop: 0, fontSize: 13 }}>
          Only replies from these people are read as a decision. A recruiter writing &ldquo;approved&rdquo;
          is never posted.
        </p>
        {people.length === 0 && <div className="muted">Nobody has been seen in the group yet.</div>}
        {people.map((p) => (
          <label key={p.id} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4 }}>
            <input type="checkbox" checked={picked.includes(p.id)} onChange={() => toggle(p.id)} disabled={busy} />
            <span>{p.name || `user ${p.id}`}{p.username ? ` (@${p.username})` : ""}</span>
          </label>
        ))}
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 10 }}>
          <input className="form-input" style={{ maxWidth: 220 }} placeholder="or a Telegram user id"
            value={form.extraId} onChange={(e) => setForm((f) => ({ ...f, extraId: e.target.value }))} disabled={busy} />
          <button className="btn btn-ghost" onClick={addExtra} disabled={busy || !form.extraId.trim()}>Add</button>
          <button className="btn btn-primary" onClick={() => save({ safetyUserIds: picked })} disabled={busy || !settings?.chatId}>
            Save Safety people
          </button>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h3 style={{ marginTop: 0 }}>4. Switch it on</h3>
        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input type="checkbox" checked={Boolean(settings?.enabled)} disabled={busy || (!ready && !settings?.enabled)}
            onChange={(e) => save({ enabled: e.target.checked }, e.target.checked ? "Safety Approvals is on." : "Switched off.")} />
          <span>Post Safety&apos;s decisions in the topic</span>
        </label>
        {!ready && (
          <div style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 6 }}>
            Save the group, the topic and at least one Safety person first.
          </div>
        )}
      </div>

      <HiringStagesCard settings={settings} proposals={proposals} busy={busy}
        onToggle={(on) => save({ stageProposalsEnabled: on }, on ? "Bitrix stage proposals are on." : "Bitrix stage proposals are off.")} />

      <div className="card" style={{ marginTop: 16 }}>
        <h3 style={{ marginTop: 0 }}>Latest Safety replies</h3>
        {recent.length === 0 ? <div className="muted">None yet.</div> : (
          <table className="data-table">
            <thead><tr><th>When</th><th>Result</th><th>Decisions</th></tr></thead>
            <tbody>
              {recent.map((r) => (
                <tr key={r.id}>
                  <td>{new Date(r.updatedAt).toLocaleString()}</td>
                  <td>{STATUS[r.status] || r.status}{r.lastError ? ` — ${r.lastError}` : ""}</td>
                  <td>{r.decisions.map((d) => `${d.name}: ${d.decision === "approved" ? "approved" : "not approved"}`).join(", ") || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

const STATUS = {
  pending: "Waiting to be read",
  published: "Posted",
  unclear: "Not clear — nothing posted",
  no_post: "Not a reply to a post the bot saw",
  gave_up: "Could not post",
};
