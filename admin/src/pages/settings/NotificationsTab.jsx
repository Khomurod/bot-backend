import React, { useState } from "react";
import { Banner } from "./fields";
import NotificationRoutingCard from "./notifications/NotificationRoutingCard";
import ControlChannelCard from "./control/ControlChannelCard";

/**
 * Settings → Notifications: where Wenze's own notices go, and how a person
 * answers them.
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
 * The four routine per-workflow group ids stay on Telegram Groups, which is
 * what that tab is actually about.
 */
export default function NotificationsTab() {
  const [message, setMessage] = useState(null);
  const flash = (type, text) => setMessage({ type, text });

  return (
    <div>
      <p style={{ color: "#94a3b8", marginTop: 0 }}>
        Everything Wenze <strong>notices</strong> — corrections it made, risks it found, problems
        it recovered from — and the one channel it can be <strong>answered</strong> on. The
        per-workflow message groups (mileage bonus, road bonus, driver raise) are on the{" "}
        <strong>Telegram Groups</strong> tab.
      </p>
      <Banner message={message} />
      <NotificationRoutingCard flash={flash} />
      <ControlChannelCard flash={flash} />
    </div>
  );
}
