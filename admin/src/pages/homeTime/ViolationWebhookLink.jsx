import React, { useState } from "react";
import { createViolationWebhookSecret } from "../../api";

/**
 * The link the three Bitrix "Webhook" robots call when a pipeline 33 card enters
 * a violation stage. The server makes a random secret, keeps it encrypted, and
 * returns it ONCE: the full link is shown here until the page is left, and
 * never again. Creating a new link replaces the old one, so the robots must be
 * given the new link.
 */
export default function ViolationWebhookLink({ isSet }) {
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  const create = async () => {
    if (isSet && !link && !window.confirm(
      "Replace the webhook link? The current link stops working at once — paste the new one into all three Bitrix robots."
    )) return;
    setBusy(true);
    setError("");
    setCopied(false);
    try {
      const { secret } = await createViolationWebhookSecret();
      setLink(
        `${window.location.origin}/api/integrations/bitrix/home-time-violation`
        + `?token=${encodeURIComponent(secret)}&deal_id={=Document:ID}`
      );
    } catch (err) {
      setError(err.message || "Could not create the link.");
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      setError("Copy failed — select the link and copy it by hand.");
    }
  };

  const set = isSet || Boolean(link);

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <p className="home-time-muted" style={{ margin: 0 }}>
        Bitrix webhook link: <b>{set ? "created" : "not created"}</b>
        {set
          ? " — it is shown only once, when created."
          : ". Without it the Bitrix robots are refused and alerts arrive only from the 30-minute check."}
      </p>

      {link && (
        <div style={{ display: "grid", gap: 6 }}>
          <input className="form-input" type="text" readOnly value={link} onFocus={(e) => e.target.select()} />
          <p className="home-time-muted" style={{ margin: 0 }}>
            Paste this into the <b>Webhook</b> robot on each of the three violation stages
            (Early, Red flag, Early &amp; overstayed). It will not be shown again.
          </p>
        </div>
      )}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="button" className="btn btn-secondary" onClick={create} disabled={busy}>
          {busy ? "Creating…" : set ? "Create a new link" : "Create webhook link"}
        </button>
        {link && (
          <button type="button" className="btn btn-primary" onClick={copy}>
            {copied ? "Copied ✓" : "Copy link"}
          </button>
        )}
      </div>

      {error && <p className="home-time-muted" style={{ margin: 0, color: "var(--danger, #c0392b)" }}>{error}</p>}
    </div>
  );
}
