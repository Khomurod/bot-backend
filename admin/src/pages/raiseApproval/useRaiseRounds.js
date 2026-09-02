import { useState } from "react";
import * as api from "../../api";

/**
 * Review rounds: sending one now, listing past rounds, and reading one round's
 * results.
 *
 * Both dates are required together — sending with only one would silently
 * change which pay period dispatch is being asked about, so a half-filled
 * range is refused rather than defaulted.
 *
 * Closing a round invalidates its dispatch link, so it is confirmed first and
 * cannot be undone from here.
 *
 * Split out of admin/src/pages/RaiseApprovalPage.jsx.
 */
export function useRaiseRounds(flash, clearStatus) {
  const [rounds, setRounds] = useState([]);
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [sending, setSending] = useState(false);
  const [lastLink, setLastLink] = useState("");
  const [selectedRound, setSelectedRound] = useState(null);
  const [roundResults, setRoundResults] = useState(null);

  /** Fetch and apply the round list. Called by the page's batched load. */
  const load = async () => {
    const r = await api.getRaiseRounds();
    setRounds(r.rounds || []);
  };

  const sendNow = async () => {
    if ((periodStart && !periodEnd) || (!periodStart && periodEnd)) {
      flash("error", "Enter both period dates, or leave both blank to use last week.");
      return;
    }
    setSending(true);
    clearStatus();
    setLastLink("");
    try {
      const res = await api.raiseSendNow({
        periodStart: periodStart || null,
        periodEnd: periodEnd || null,
      });
      setLastLink(res.link || "");
      await load();
      flash("success", "Review sent to the employee group.");
    } catch (err) {
      flash("error", err.message);
    } finally {
      setSending(false);
    }
  };

  const viewRound = async (round) => {
    setSelectedRound(round);
    setRoundResults(null);
    try {
      const res = await api.getRaiseRoundResults(round.id);
      setRoundResults(res);
    } catch (err) {
      flash("error", err.message);
    }
  };

  const closeRound = async (round) => {
    if (!window.confirm("Close this round? The dispatch link will stop working.")) return;
    try {
      await api.closeRaiseRound(round.id);
      await load();
      flash("success", "Round closed.");
    } catch (err) {
      flash("error", err.message);
    }
  };

  return {
    rounds, periodStart, setPeriodStart, periodEnd, setPeriodEnd,
    sending, lastLink, sendNow,
    selectedRound, roundResults, viewRound, closeRound, load,
  };
}
