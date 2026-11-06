import React, { useState } from "react";
import "./birthday.css";

const CONFETTI = 36;
const BALLOONS = 7;

/**
 * A birthday on the race board (the owner, 6 November 2026): confetti and
 * balloons in CSS, "Happy Birthday". An employee is shown with the card that
 * went to the employee group (from GET /api/gross-race/birthday-card/:key); a
 * driver with their name, large, and their truck. A card that no longer loads
 * falls back to the name.
 */
export default function BirthdayOverlay({ birthday }) {
  const [cardFailed, setCardFailed] = useState(false);
  if (!birthday) return null;
  const { kind, name, subtitle, truck, card } = birthday;
  const withCard = kind === "employee" && card && !cardFailed;
  return (
    <div className="gr-bday" role="dialog" aria-label="Happy Birthday">
      <div className="gr-bday-confetti" aria-hidden="true">
        {Array.from({ length: CONFETTI }, (_, i) => (
          <span key={i} style={{ "--i": i, "--x": `${(i * 37) % 100}%`, "--d": `${(i * 53) % 30 / 10}s` }} />
        ))}
      </div>
      <div className="gr-bday-balloons" aria-hidden="true">
        {Array.from({ length: BALLOONS }, (_, i) => (
          <span key={i} style={{ "--i": i, "--x": `${6 + i * 14}%`, "--d": `${(i * 7) % 10 / 4}s` }} />
        ))}
      </div>
      <div className={`gr-bday-card${withCard ? " gr-bday-card--photo" : ""}`}>
        <div className="gr-bday-title">Happy Birthday!</div>
        {withCard ? (
          <img className="gr-bday-photo" src={card} alt={`${name}'s birthday card`} onError={() => setCardFailed(true)} />
        ) : (
          <>
            <div className="gr-bday-name">{name}</div>
            {kind === "employee" && subtitle ? <div className="gr-bday-sub">{subtitle}</div> : null}
            {kind === "driver" && truck ? <div className="gr-bday-truck">Truck {truck}</div> : null}
          </>
        )}
      </div>
    </div>
  );
}
