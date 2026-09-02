import { useState, useEffect } from "react";
import * as api from "../../api";

/**
 * Past broadcasts for one kind ('regular' or 'confirmation'), with per-broadcast
 * delivery rows and — for confirmations — button clicks.
 *
 * Both are LAZY and CACHED: a broadcast's delivery list is one row per driver
 * group, so it is fetched only when that row is expanded and then kept, which
 * makes collapsing and re-expanding free.
 *
 * One instance per tab. Each keeps its own expansion state, so opening a
 * delivery list on one tab does not disturb the other.
 *
 * Split out of admin/src/pages/BroadcastPage.jsx.
 */
export function useBroadcastHistory(kind) {
  const [history, setHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [expandedId, setExpandedId] = useState(null);
  const [deliveries, setDeliveries] = useState({});
  const [clicks, setClicks] = useState({});
  const [expandedClicks, setExpandedClicks] = useState(null);

  const loadHistory = async () => {
    setHistoryLoading(true);
    try {
      const data = await api.getBroadcastHistory(kind);
      setHistory(data);
    } catch (err) { console.error(err); }
    setHistoryLoading(false);
  };

  useEffect(() => { loadHistory(); }, []);

  const toggleDeliveries = async (id) => {
    if (expandedId === id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(id);
    if (!deliveries[id]) {
      try {
        const data = await api.getBroadcastDeliveries(id);
        setDeliveries(prev => ({ ...prev, [id]: data }));
      } catch (err) { console.error(err); }
    }
  };

  const toggleClicks = async (id) => {
    if (expandedClicks === id) {
      setExpandedClicks(null);
      return;
    }
    setExpandedClicks(id);
    if (!clicks[id]) {
      try {
        const data = await api.getConfirmationClicks(id);
        setClicks(prev => ({ ...prev, [id]: data }));
      } catch (err) { console.error(err); }
    }
  };

  const getClickSummary = (clicks) => {
    const summary = {};
    clicks.forEach(c => {
      const label = c.button_label || `Button ${Number(c.button_index) + 1}`;
      summary[label] = (summary[label] || 0) + 1;
    });
    return Object.entries(summary);
  };

  return {
    history, historyLoading, loadHistory,
    expandedId, deliveries, toggleDeliveries,
    expandedClicks, clicks, toggleClicks, getClickSummary,
  };
}
