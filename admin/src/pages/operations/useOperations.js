/**
 * All state and every request for Needs Attention.
 *
 * The page component below this is layout and nothing else — the same split as
 * `homeTime/useHomeTimeOverview.js`, for the same reason: once a page has a
 * drawer, a tab bar and four endpoints, mixing the fetching into the JSX is how
 * it stops being reviewable.
 *
 * Two behaviours here are deliberate and easy to get wrong.
 *
 *   A FAILED REFRESH MUST NOT RENDER AS AN EMPTY PAGE. `failure` is kept beside
 *   the last good data rather than replacing it, so a database hiccup shows a
 *   banner over the findings you already had — never a reassuring "nothing to
 *   see". Empty data presented as normal is the exact failure mode
 *   `server/middleware/failureResponse.js` was written to remove, and it would
 *   be a shame to reintroduce it one layer up.
 *
 *   A 409 IS NOT AN ERROR. Applying or reverting can come back "the evidence
 *   moved" — somebody edited the row, or fixed it by hand first. That is the
 *   system working. It refreshes the finding and says so, rather than offering
 *   a retry that would fail identically.
 */
import { useCallback, useEffect, useState } from 'react';

import * as api from '../../api';
import useVisibleInterval from '../../utils/useVisibleInterval';

/**
 * The sweep runs every 15 minutes, so polling faster only costs egress without
 * ever showing anything new. `useVisibleInterval` additionally stops entirely
 * while the tab is hidden and fires once on return.
 */
export const REFRESH_MS = 60000;

/** One page of correction history. Revert lives only on that tab. */
export const HISTORY_PAGE_SIZE = 50;

/**
 * `initialTab` is which tab to OPEN ON, and the page validates it against its
 * own TABS before handing it over — the key list lives there with the labels,
 * so this hook does not keep a second copy that could drift from it. Anything
 * falsy opens Needs attention, which is where the page has always opened.
 */
export default function useOperations({ flash, initialTab } = {}) {
  const [tab, setTab] = useState(() => initialTab || 'findings');
  const [summary, setSummary] = useState(null);
  const [findings, setFindings] = useState([]);
  const [corrections, setCorrections] = useState([]);
  const [historyComplete, setHistoryComplete] = useState(false);
  const [loadingMoreHistory, setLoadingMoreHistory] = useState(false);
  const [checks, setChecks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState(null);
  const [busy, setBusy] = useState(false);
  const [sweeping, setSweeping] = useState(false);
  const [includeDismissed, setIncludeDismissed] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);

  const load = useCallback(async () => {
    try {
      const [summaryData, findingsData] = await Promise.all([
        api.getOperationsSummary(),
        api.getOperationsFindings({
          status: includeDismissed ? 'all' : 'open',
          includeSnoozed: includeDismissed,
        }),
      ]);
      setSummary(summaryData);
      setFindings(findingsData.findings || []);
      setFailure(null);
    } catch (err) {
      // Keep whatever we already had on screen; the banner explains the rest.
      setFailure(err);
    } finally {
      setLoading(false);
    }
  }, [includeDismissed]);

  /**
   * Load the first page of history, replacing whatever is there.
   *
   * Paged rather than a fixed newest-100, because Revert lives ONLY on this tab:
   * a correction that scrolls off the end stops being undoable through the
   * admin at all. An enabled check can apply up to its cap in a single run, so
   * "more than a hundred" is not a distant hypothetical.
   */
  const loadHistory = useCallback(async () => {
    try {
      const data = await api.getOperationsCorrections({ limit: HISTORY_PAGE_SIZE, offset: 0 });
      const rows = data.corrections || [];
      setCorrections(rows);
      setHistoryComplete(rows.length < HISTORY_PAGE_SIZE);
    } catch (err) {
      setFailure(err);
    }
  }, []);

  const loadMoreHistory = useCallback(async () => {
    setLoadingMoreHistory(true);
    try {
      const data = await api.getOperationsCorrections({
        limit: HISTORY_PAGE_SIZE, offset: corrections.length,
      });
      const rows = data.corrections || [];
      // Append by id so a correction applied since the first page cannot be
      // shown twice when the offset shifts under us.
      setCorrections((prev) => {
        const seen = new Set(prev.map((c) => c.id));
        return [...prev, ...rows.filter((c) => !seen.has(c.id))];
      });
      setHistoryComplete(rows.length < HISTORY_PAGE_SIZE);
    } catch (err) {
      setFailure(err);
    } finally {
      setLoadingMoreHistory(false);
    }
  }, [corrections.length]);

  const loadChecks = useCallback(async () => {
    try {
      const data = await api.getOperationsChecks();
      setChecks(data.checks || []);
    } catch (err) {
      setFailure(err);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (tab === 'history') loadHistory();
    if (tab === 'checks') loadChecks();
  }, [tab, loadHistory, loadChecks]);
  useVisibleInterval(load, REFRESH_MS);

  const openFinding = useCallback(async (id) => {
    setSelectedId(id);
    setDetail(null);
    try {
      setDetail(await api.getOperationsFinding(id));
    } catch (err) {
      setFailure(err);
      setSelectedId(null);
    }
  }, []);

  const closeFinding = useCallback(() => {
    setSelectedId(null);
    setDetail(null);
  }, []);

  /**
   * Shared tail for every action that changes something: report, refresh, and
   * treat a conflict as news rather than as a fault.
   */
  const run = useCallback(async (work, { success, refreshDetail = true } = {}) => {
    setBusy(true);
    try {
      await work();
      flash('success', success);
      await load();
      if (refreshDetail && selectedId) {
        setDetail(await api.getOperationsFinding(selectedId).catch(() => null));
      }
      return true;
    } catch (err) {
      if (err?.status === 409) {
        flash('warning', `${err.detail || err.message} — reloading what is there now.`);
        await load();
        if (selectedId) setDetail(await api.getOperationsFinding(selectedId).catch(() => null));
        return false;
      }
      if (err?.status === 403) {
        flash('error', 'You can view this page but not change fleet records. '
          + 'That needs the "operations.corrections.apply" permission.');
        return false;
      }
      flash('error', err?.detail || err?.message || 'That did not work.');
      return false;
    } finally {
      setBusy(false);
    }
  }, [flash, load, selectedId]);

  const applyFinding = useCallback((id, reason) => run(
    () => api.applyFindingCorrection(id, reason),
    { success: 'Applied, recorded and reversible.' }
  ), [run]);

  const dismissFinding = useCallback((id, reason) => run(
    () => api.dismissOperationsFinding(id, reason),
    { success: 'Dismissed. It will stay dismissed even while the condition holds.' }
  ), [run]);

  const snoozeFinding = useCallback((id, hours) => run(
    () => api.snoozeOperationsFinding(id, hours),
    { success: 'Snoozed — set aside, not resolved.' }
  ), [run]);

  // FORGETTING IS A DECISION TOO, so it refreshes the finding beneath it: the
  // question comes back on the next sweep, and this screen should not keep
  // claiming the answer is still standing.
  const forgetAnswer = useCallback((id) => run(
    () => api.forgetControlAnswer(id),
    { success: 'Forgotten. Wenze will ask about this again.' }
  ), [run]);

  const revertCorrection = useCallback(async (id, reason) => {
    const ok = await run(
      () => api.revertOperationsCorrection(id, reason),
      { success: 'Reverted. The original record still says it happened.', refreshDetail: false }
    );
    if (ok) await loadHistory();
    return ok;
  }, [run, loadHistory]);

  const setCheckEnabled = useCallback(async (checkKey, patch) => {
    const ok = await run(
      () => api.updateOperationsCheck(checkKey, patch),
      { success: 'Saved.', refreshDetail: false }
    );
    if (ok) await loadChecks();
    return ok;
  }, [run, loadChecks]);

  const runSweep = useCallback(async () => {
    setSweeping(true);
    try {
      await api.runOperationsSweep();
      await load();
      flash('success', 'Checks re-run.');
    } catch (err) {
      flash('error', err?.detail || err?.message || 'The sweep did not run.');
    } finally {
      setSweeping(false);
    }
  }, [flash, load]);

  return {
    tab, setTab,
    summary, findings, corrections, checks,
    loading, failure, busy, sweeping,
    includeDismissed, setIncludeDismissed,
    selectedId, detail, openFinding, closeFinding,
    load, loadHistory, loadChecks,
    loadMoreHistory, historyComplete, loadingMoreHistory,
    applyFinding, dismissFinding, snoozeFinding, revertCorrection, forgetAnswer,
    setCheckEnabled, runSweep,
  };
}
