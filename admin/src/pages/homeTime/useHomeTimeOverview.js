import { useState, useEffect } from "react";
import * as api from "../../api";
import {
  HOME_TIME_SORT_COLUMNS, STATUS_FILTERS,
  buildDriverTimeline, buildHomeTimeViewModel,
} from "../homeTimeViewModel";
import { toDateInput } from "./labels";

/**
 * The Home Time overview: statuses, completed trips, requests, the derived view
 * model, and every edit that writes back to them.
 *
 * EVERY WRITE RELOADS THE WHOLE OVERVIEW. Editing one driver's state or a trip
 * recomputes bonus, on-road days and next-eligible-home-time server-side, so
 * patching a row locally would leave the panel showing counters that no longer
 * follow from the data.
 *
 * The selection is kept VALID against the filtered list: changing a filter or
 * search that hides the selected driver moves the selection to the first
 * remaining row and closes the detail popup, rather than leaving a popup open
 * over a driver no longer in view.
 *
 * Statuses and requests are fetched together, and the request fetch swallows
 * its own failure — the driver list is the screen's reason to exist and must
 * still render when the requests endpoint is unavailable.
 *
 * Split out of admin/src/pages/HomeTimePage.jsx.
 */
export function useHomeTimeOverview(flash, setStatus) {
  const [settings, setSettings] = useState(null);
  const [statuses, setStatuses] = useState([]);
  const [history, setHistory] = useState([]);
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [statusFilter, setStatusFilter] = useState("active");
  const [driverQuery, setDriverQuery] = useState("");
  const [sortKey, setSortKey] = useState("unit_number");
  const [sortDirection, setSortDirection] = useState("asc");
  const [selectedGroupId, setSelectedGroupId] = useState(null);
  const [isDetailOpen, setIsDetailOpen] = useState(false);
  const [stateSinceDraft, setStateSinceDraft] = useState("");
  const [stateDraft, setStateDraft] = useState("");
  const [tripDrafts, setTripDrafts] = useState({});
  const [reg, setReg] = useState({
    group_id: "",
    home_from: "",
    home_to: "",
    status: "approved",
    note: "",
  });

  const load = async () => {
    try {
      const [res, reqRes] = await Promise.all([
        api.getHomeTimeOverview(),
        api.getHomeTimeRequests().catch(() => ({ requests: [] })),
      ]);
      setSettings(res.settings);
      setStatuses(res.statuses || []);
      setHistory(res.history || []);
      setRequests(reqRes.requests || []);
    } catch (err) {
      flash("error", err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const saveSettings = async (patch) => {
    setSaving(true);
    setStatus(null);
    try {
      const res = await api.updateHomeTimeSettings(patch);
      setSettings(res.settings);
      flash("success", "Settings saved.");
    } catch (err) {
      flash("error", err.message);
    } finally {
      setSaving(false);
    }
  };

  const saveStatusSince = async (groupId, dateStr) => {
    setStatus(null);
    try {
      await api.updateHomeTimeStatusSince(groupId, dateStr);
      flash("success", "Start date updated.");
      await load();
    } catch (err) {
      flash("error", err.message);
    }
  };

  const saveSelectedState = async () => {
    if (!selectedStatus || !stateDraft || stateDraft === selectedStatus.state) return;
    setStatus(null);
    try {
      const payload = { state: stateDraft };
      // When the date draft is explicitly edited too, send it so the new cycle
      // starts from the chosen date instead of "now".
      if (stateSinceDraft && stateSinceDraft !== toDateInput(selectedStatus.state_since)) {
        payload.state_since = stateSinceDraft;
      }
      await api.updateHomeTimeStatus(selectedStatus.group_id, payload);
      flash("success", "Current state updated.");
      await load();
    } catch (err) {
      flash("error", err.message);
    }
  };

  const saveTrip = async (id, road, home) => {
    setStatus(null);
    try {
      await api.updateHomeTimeTrip(id, {
        road_started_at: road,
        home_arrived_at: home,
      });
      flash("success", "Trip dates updated.");
      await load();
    } catch (err) {
      flash("error", err.message);
    }
  };

  const removeTrip = async (id) => {
    if (!window.confirm("Delete this completed trip record?")) return;
    setStatus(null);
    try {
      await api.deleteHomeTimeTrip(id);
      flash("success", "Trip deleted.");
      await load();
    } catch (err) {
      flash("error", err.message);
    }
  };

  const registerRequest = async (e) => {
    e.preventDefault();
    if (!selectedStatus) {
      flash("error", "Select a driver first.");
      return;
    }
    setStatus(null);
    try {
      await api.createHomeTimeRequest({
        group_id: selectedStatus.group_id,
        home_from: reg.home_from,
        home_to: reg.home_to,
        status: reg.status,
        note: reg.note || null,
      });
      flash("success", "Home-time request registered.");
      setReg((current) => ({
        ...current,
        group_id: String(selectedStatus.group_id),
        home_from: "",
        home_to: "",
        status: "approved",
        note: "",
      }));
      await load();
    } catch (err) {
      flash("error", err.message);
    }
  };

  const viewModel = buildHomeTimeViewModel({
    statuses,
    history,
    requests,
    statusFilter,
    searchQuery: driverQuery,
    sortKey,
    sortDirection,
  });

  const {
    onRoad,
    atHome,
    overLimit,
    inactiveCount,
    companyCount,
    ownerCount,
    filteredStatuses,
    requestsByGroupId,
    historyByGroupId,
    unlinkedActivity,
  } = viewModel;

  useEffect(() => {
    if (!filteredStatuses.length) {
      setSelectedGroupId(null);
      setIsDetailOpen(false);
      return;
    }
    if (selectedGroupId == null) {
      setSelectedGroupId(filteredStatuses[0].group_id);
      return;
    }
    const hasSelection = filteredStatuses.some((row) => Number(row.group_id) === Number(selectedGroupId));
    if (!hasSelection) {
      setSelectedGroupId(filteredStatuses[0].group_id);
      setIsDetailOpen(false);
    }
  }, [filteredStatuses, selectedGroupId]);

  const selectedStatus =
    filteredStatuses.find((row) => Number(row.group_id) === Number(selectedGroupId))
    || statuses.find((row) => Number(row.group_id) === Number(selectedGroupId))
    || null;
  const selectedRequests = selectedStatus ? (requestsByGroupId.get(Number(selectedStatus.group_id)) || []) : [];
  const selectedHistory = selectedStatus ? (historyByGroupId.get(Number(selectedStatus.group_id)) || []) : [];
  const selectedTimeline = buildDriverTimeline({
    requests: selectedRequests,
    history: selectedHistory,
  });
  const selectedLifetimeBonus = selectedHistory.reduce((sum, row) => sum + Number(row.bonus_usd || 0), 0);
  const selectedPendingRequests = selectedRequests.filter((row) => row.status === "pending").length;
  const selectedFilterLabel =
    STATUS_FILTERS.find((filter) => filter.value === statusFilter)?.label || "All active drivers";

  useEffect(() => {
    if (!selectedStatus) {
      setStateSinceDraft("");
      setStateDraft("");
      return;
    }
    setStateSinceDraft(toDateInput(selectedStatus.state_since));
    setStateDraft(selectedStatus.state || "");
    setTripDrafts({});
    setReg((current) => ({
      ...current,
      group_id: String(selectedStatus.group_id),
    }));
  }, [selectedStatus]);

  useEffect(() => {
    if (!isDetailOpen) return undefined;
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        setIsDetailOpen(false);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [isDetailOpen]);

  const updateTripDraft = (tripId, field, value) => {
    setTripDrafts((current) => ({
      ...current,
      [tripId]: {
        ...(current[tripId] || {}),
        [field]: value,
      },
    }));
  };

  const saveSelectedSince = async () => {
    if (!selectedStatus || !stateSinceDraft) return;
    await saveStatusSince(selectedStatus.group_id, stateSinceDraft);
  };

  const openDriverDetails = (groupId) => {
    setSelectedGroupId(groupId);
    setIsDetailOpen(true);
  };

  const toggleSort = (columnKey) => {
    if (!HOME_TIME_SORT_COLUMNS.includes(columnKey)) return;
    if (sortKey === columnKey) {
      setSortDirection((current) => (current === "asc" ? "desc" : "asc"));
      return;
    }
    setSortKey(columnKey);
    setSortDirection("asc");
  };

  return {
    settings, statuses, history, requests, loading, saving,
    statusFilter, setStatusFilter, driverQuery, setDriverQuery,
    sortKey, sortDirection, toggleSort,
    selectedGroupId, isDetailOpen, setIsDetailOpen, openDriverDetails,
    stateSinceDraft, setStateSinceDraft, stateDraft, setStateDraft,
    tripDrafts, updateTripDraft, reg, setReg,
    onRoad, atHome, overLimit, inactiveCount, companyCount, ownerCount,
    filteredStatuses, unlinkedActivity, selectedFilterLabel,
    selectedStatus, selectedRequests, selectedHistory, selectedTimeline,
    selectedLifetimeBonus, selectedPendingRequests,
    load, saveSettings, saveSelectedState, saveSelectedSince,
    saveTrip, removeTrip, registerRequest,
  };
}
