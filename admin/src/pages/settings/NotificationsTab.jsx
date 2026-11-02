import React, { useState } from "react";
import { Banner } from "./fields";
import NotificationRoutingCard from "./notifications/NotificationRoutingCard";
import TelegramGroupsTab from "./TelegramGroupsTab";

/**
 * Settings → Where the Bot Posts (`#settings/notifications`): where Wenze's own
 * notices go, and where the two bonus cards go.
 *
 * ONE SECTION SINCE NOVEMBER 2026. "Notifications" and "Bonus Groups" were two
 * sections, and Bonus Groups was a whole section for two fields; both answer
 * "which Telegram group does this go to?". They stay two cards with their own
 * saves — the routing card saves each field as you leave it, the bonus groups
 * with their button — and the old `#settings/groups` address lands here
 * (SETTINGS_SECTION_ALIASES). The per-kind overrides are collapsed.
 *
 * HOW A PERSON ANSWERS THEM MOVED (November 2026). "Answering Wenze in
 * Telegram" (ControlChannelCard) is now under Settings → AI → Wenze's
 * Questions, beside "What Wenze learned from you": both are Wenze asking in the
 * notifications group and a person replying. The history below explains why it
 * left Telegram Groups first; that reasoning — it is a two-way channel, not a
 * destination — is also why it no longer sits among the destinations here.
 *
 * WHY THESE LEFT TELEGRAM GROUPS. That tab's own note argued they belonged
 * together — "both are destinations, so they belong on one screen rather than
 * two" — and the part of that which was load-bearing is kept: the two are still
 * SEPARATE CARDS, which is what stops an operator changing the wrong one. What
 * did not survive is the screen. Two concrete reasons:
 *
 *   The banner was in the wrong place. Both cards report through a `flash`
 *   callback into the host tab's banner, and on Telegram Groups that banner
 *   sits at the TOP — above four group-id fields and two paragraphs of
 *   explanation. Saving the control channel flashed "Saved." a screenful away
 *   from the card that saved. Here the banner is next to them.
 *
 *   The control channel is not a destination. It is a two-way channel with an
 *   operator allow-list: notices go out, replies come back and CHANGE
 *   OPERATIONAL STATE. Filing it under "the Telegram group each message
 *   category is sent to" undersold what it is. See
 *   `docs/architecture/control-channel.md`.
 *
 * The routine per-workflow group ids (the bonus groups) are the second card.
 */
export default function NotificationsTab() {
  const [message, setMessage] = useState(null);
  const flash = (type, text) => setMessage({ type, text });

  return (
    <div>
      <p style={{ color: "var(--text-muted)", marginTop: 0 }}>
        The Telegram groups the bot posts to: everything Wenze <strong>notices</strong>, and the
        bonus cards. How a person answers Wenze is under{" "}
        <a href="#settings/ai_questions">Wenze&apos;s Questions</a>.
      </p>
      <Banner message={message} />
      <NotificationRoutingCard flash={flash} />
      <TelegramGroupsTab />
    </div>
  );
}
