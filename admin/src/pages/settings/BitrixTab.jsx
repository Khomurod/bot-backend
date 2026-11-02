import React, { useState } from "react";
import { Banner } from "./fields";
import BitrixCard from "./ringcentral/BitrixCard";

/**
 * Settings → Bitrix24 (`#settings/bitrix`): the connection to the CRM, and the
 * matching of recruiters to Bitrix users.
 *
 * Its own section since November 2026. It was a card on the RingCentral
 * screen, on purpose — the Bitrix ASSIGNEE decides which recruiter's number
 * texts a lead — but four features read this connection (the lead SMS sender,
 * the Board ↔ Bitrix check, the hiring-stage proposals and Facebook ↔ Bitrix),
 * and that screen had grown to six cards. The recruiter rows it matches are
 * one click away under Recruiters & Numbers.
 */
export default function BitrixTab() {
  const [message, setMessage] = useState(null);
  return (
    <div>
      <p style={{ color: "var(--text-muted)", marginTop: 0 }}>
        The CRM connection the lead texts, the Board ↔ Bitrix check, the hiring-stage proposals
        and Facebook ↔ Bitrix all read. Each recruiter's Bitrix user is set on their row under{" "}
        <a href="#settings/ringcentral">Recruiters &amp; Numbers</a>.
      </p>
      <Banner message={message} />
      <BitrixCard
        onMessage={setMessage}
        onMapped={() => setMessage({ type: "success", text: "Recruiters matched. Their rows under Recruiters & Numbers show the Bitrix user now." })}
      />
    </div>
  );
}
