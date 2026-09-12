import React, { useCallback, useEffect, useState } from "react";
import * as api from "../../../api";

/**
 * Settings → Dispatcher Board → Feed.
 *
 * What the poller last stored, read back from Wenze's own snapshot rather than
 * from the board. That distinction is the point of the card: "the board has 102
 * rows" and "Wenze knows about 102 rows" are different claims, and only the
 * second one is what every other feature will be answering from.
 *
 * COUNTS ONLY. No name, no phone, no truck. A card that answers "is the feed
 * alive and does it look right" needs none of them, and a settings screen is
 * the wrong place to put the fleet's data.
 *
 * LABELS THAT DO NOT COLLIDE WITH THE TEST CARD ABOVE. Test reports what the
 * board answered a second ago; this reports what Wenze has stored. Two cards on
 * one screen giving two different numbers the same name is how a reader ends up
 * trusting the wrong one.
 *
 * READ-ONLY. Nothing here starts a poll or edits a row — the poller owns the
 * snapshot, and two writers would be the exact disagreement this whole feature
 * exists to prevent.
 */

function Row({ label, value, tone }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", fontSize: 13 }}>
      <span style={{ color: "#94a3b8" }}>{label}</span>
      <strong style={tone ? { color: tone } : undefined}>{value}</strong>
    </div>
  );
}

export default function FeedCard() {
  const [feed, setFeed] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setFeed(await api.getDispatchBoardFeed());
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  if (loading) return <div style={{ padding: 14, color: "#94a3b8" }}>Reading the feed…</div>;
  if (error) return <div className="alert alert-error" style={{ marginTop: 16 }}>{error}</div>;

  const summary = feed?.summary || {};
  const fleet = summary.fleet || {};
  const statuses = summary.statuses || [];
  const neverRead = !feed?.lastPollAt;

  return (
    <div className="ios-glass" style={{ padding: 14, marginTop: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <div style={{ fontWeight: 600 }}>Feed</div>
        <button className="btn btn-ghost touch-target" style={{ padding: "2px 10px", fontSize: 12 }} onClick={load}>
          Refresh
        </button>
      </div>

      {neverRead ? (
        <div style={{ fontSize: 13, color: "#94a3b8" }}>
          The board has not been read yet. It is checked a minute after each deploy and then on the
          interval above — nothing is read while it is switched off.
        </div>
      ) : (
        <>
          <Row label="Last read" value={new Date(feed.lastPollAt).toLocaleString()} />
          <Row
            label="Result"
            value={feed.lastPollOk ? "ok" : "failed"}
            tone={feed.lastPollOk ? undefined : "#f87171"}
          />
          {feed.lastPollBoardDate && <Row label="Board date" value={feed.lastPollBoardDate} />}
          {feed.lastError && (
            <div style={{ marginTop: 8, fontSize: 12, color: "#f87171" }}>{feed.lastError}</div>
          )}
        </>
      )}

      <div style={{ height: 1, background: "rgba(148,163,184,0.2)", margin: "10px 0" }} />

      <Row label="Rows on the board now" value={summary.present ?? 0} />
      <Row label="Rows Wenze has ever seen" value={summary.total ?? 0} />
      <Row label="Company" value={fleet.company ?? 0} />
      <Row label="Lease" value={fleet.lease ?? 0} />
      <Row label="Owner operator" value={fleet.owner_operator ?? 0} />
      <Row
        label="Fleet Wenze cannot read"
        value={fleet.unknown ?? 0}
        tone={fleet.unknown ? "#f59e0b" : undefined}
      />
      <Row label="Teams" value={summary.teams ?? 0} />
      <Row label="Matched to a person" value={summary.linked ?? 0} />

      <div style={{ marginTop: 10, fontSize: 12, color: "#94a3b8" }}>
        Statuses: {statuses.length
          ? statuses.map((s) => `${s.status} ${s.count}`).join(" · ")
          : "none"}
      </div>
      <div style={{ marginTop: 8, fontSize: 12, color: "#64748b" }}>
        Matching a board row to a driver's permanent identity is a separate step and is not switched
        on yet — nothing here changes a driver's record.
      </div>
    </div>
  );
}
