import { useState, useEffect } from "react";
import { useRaiseSettings } from "./useRaiseSettings";
import { useRaiseTeams } from "./useRaiseTeams";
import { useTeamPanel } from "./useTeamPanel";
import { useRaiseRounds } from "./useRaiseRounds";

/**
 * The page's container hook: it owns the status banner and the initial load,
 * and composes the four per-concern hooks.
 *
 * The initial fetch stays a SINGLE batched load — settings, teams and rounds
 * are requested together and `loading` clears only when all three have
 * arrived, so the page never renders half-populated. Giving each hook its own
 * useEffect would have shown the teams card before the settings card had data.
 *
 * `flash` and `clearStatus` are passed down rather than each hook owning a
 * banner, so two concurrent operations cannot leave two contradictory
 * messages on screen.
 *
 * Split out of admin/src/pages/RaiseApprovalPage.jsx.
 */
export function useRaiseApproval() {
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState(null);

  const flash = (type, text) => setStatus({ type, text });
  const clearStatus = () => setStatus(null);

  const settings = useRaiseSettings(flash, clearStatus);
  const teams = useRaiseTeams(flash);
  const panel = useTeamPanel(flash, clearStatus, teams.refreshTeams);
  const rounds = useRaiseRounds(flash, clearStatus);

  useEffect(() => {
    (async () => {
      try {
        await Promise.all([settings.load(), teams.load(), rounds.load()]);
      } catch (err) {
        flash("error", err.message);
      } finally {
        setLoading(false);
      }
    })();
    // Mount only, as before: the load is re-run through each hook's own
    // refresh path, never by re-running this effect.
  }, []);

  return { loading, status, flash, settings, teams, panel, rounds };
}
