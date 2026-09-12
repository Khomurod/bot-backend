import { useState, useEffect, useCallback } from "react";
import * as api from "../../../api";
import { normalizeEtaEnabled } from "./helpers";

/**
 * Automatic ETA updates: which driver groups receive them, how often, and where
 * they go.
 *
 * DRIVER MODE AND TEST MODE ARE MUTUALLY EXCLUSIVE per group, and the payloads
 * below enforce it — enabling one always sends the other as false. A group in
 * both modes would post to a driver group AND the test group on every pass,
 * which is exactly the mistake this shape prevents.
 *
 * Enabling test mode without DISPATCH_ETA_TEST_GROUP_ID configured is refused
 * up front rather than saved and left silently non-delivering.
 *
 * Enabling a group sends an IMMEDIATE update, and a failed first send is
 * reported as an error even though the setting saved — the admin needs to know
 * the schedule is on but the first attempt did not land.
 *
 * Saving the global intervals re-applies them to every row BY TARGET and
 * deliberately leaves each row's enabled/disabled state alone.
 *
 * The per-group diagnostics fetch went with the Dispatch Center: it called an
 * endpoint that reached Telegram, Samsara and the ETA router on every expand,
 * to render a debugging console on a settings page. Operations → System & AI
 * Health answers the same question from recorded runs. See
 * `docs/architecture/retired-dispatch-center.md`.
 *
 * Originally split out of admin/src/pages/DispatchPage.jsx.
 */
export function useEtaTracking(setMessage) {
  const [testingGroups, setTestingGroups] = useState([]);
  const [dispatchEtaTestGroupId, setDispatchEtaTestGroupId] = useState("");
  const [testingLoading, setTestingLoading] = useState(false);
  const [testingSavingGroupId, setTestingSavingGroupId] = useState(null);
  const [testingBulkSavingMode, setTestingBulkSavingMode] = useState(null);
  const [globalDriverIntervalMin, setGlobalDriverIntervalMin] = useState(60);
  const [globalTestIntervalMin, setGlobalTestIntervalMin] = useState(60);
  const [savingGlobalIntervals, setSavingGlobalIntervals] = useState(false);

  const loadTestingGroups = useCallback(async () => {
    setTestingLoading(true);
    try {
      const data = await api.getDispatchTestingGroups();
      const rows = Array.isArray(data?.groups) ? data.groups : [];
      setTestingGroups(rows);
      setDispatchEtaTestGroupId(String(data?.dispatchEtaTestGroupId || "").trim());
      const gd = Number(data?.globalDriverIntervalMinutes);
      const gt = Number(data?.globalTestIntervalMinutes);
      if (Number.isInteger(gd) && gd >= 1 && gd <= 1440) setGlobalDriverIntervalMin(gd);
      if (Number.isInteger(gt) && gt >= 1 && gt <= 1440) setGlobalTestIntervalMin(gt);
    } catch (err) {
      setMessage({ type: "error", text: `Testing feature load failed: ${err.message}` });
    } finally {
      setTestingLoading(false);
    }
  }, []);

  useEffect(() => {
    loadTestingGroups();
  }, [loadTestingGroups]);

  const handleTestingToggle = async (row, mode, nextEnabled) => {
    if (!row?.group_id) return;
    if (mode === "test" && nextEnabled && !dispatchEtaTestGroupId) {
      setMessage({ type: "error", text: "DISPATCH_ETA_TEST_GROUP_ID is not configured on server." });
      return;
    }

    const intervalMinutes = nextEnabled
      ? (mode === "test" ? globalTestIntervalMin : globalDriverIntervalMin)
      : Number(row.eta_interval_minutes) > 0
        ? Number(row.eta_interval_minutes)
        : (mode === "test" ? globalTestIntervalMin : globalDriverIntervalMin);

    setTestingSavingGroupId(row.group_id);
    setMessage(null);
    try {
      const payload = mode === "test"
        ? { enabledDriver: false, enabledTest: nextEnabled, intervalMinutes }
        : { enabledDriver: nextEnabled, enabledTest: false, intervalMinutes };
      const response = await api.updateDispatchTestingGroup(row.group_id, {
        ...payload,
      });

      const saved = response?.setting || {};
      setTestingGroups((current) => current.map((group) => (
        group.group_id === row.group_id ? { ...group, ...saved } : group
      )));
      if (nextEnabled) {
        if (response?.immediate?.success) {
          const destination = mode === "test"
            ? `test group ${dispatchEtaTestGroupId}`
            : "driver group";
          setMessage({ type: "success", text: `ETA updates enabled for ${row.group_name} -> ${destination}. Immediate update sent.` });
        } else {
          const immediateError = response?.immediate?.error || "Immediate ETA attempt failed.";
          setMessage({ type: "error", text: `ETA enabled for ${row.group_name}, but first send failed: ${immediateError}` });
        }
      } else {
        setMessage({ type: "success", text: `ETA updates disabled for ${row.group_name}.` });
      }
    } catch (err) {
      setMessage({ type: "error", text: err.message });
    } finally {
      setTestingSavingGroupId(null);
    }
  };

  const handleTestingToggleAll = async (mode, nextEnabled) => {
    if (mode === "test" && nextEnabled && !dispatchEtaTestGroupId) {
      setMessage({ type: "error", text: "DISPATCH_ETA_TEST_GROUP_ID is not configured on server." });
      return;
    }

    const intervalMinutes = nextEnabled
      ? (mode === "test" ? globalTestIntervalMin : globalDriverIntervalMin)
      : 60;

    setTestingBulkSavingMode(mode);
    setMessage(null);
    try {
      const response = await api.updateAllDispatchTestingGroups({
        enabled: nextEnabled,
        targetMode: mode,
        intervalMinutes,
      });
      const rows = Array.isArray(response?.groups) ? response.groups : [];
      if (rows.length) {
        setTestingGroups(rows);
      } else {
        await loadTestingGroups();
      }
      if (nextEnabled) {
        const immediateOk = Number(response?.immediate?.success || 0);
        const immediateFailed = Number(response?.immediate?.failed || 0);
        const destination = mode === "test"
          ? `test group ${dispatchEtaTestGroupId}`
          : "driver groups";
        setMessage({
          type: immediateFailed > 0 ? "error" : "success",
          text: `Enabled ${mode} updates for ${response?.updatedCount || rows.length} groups -> ${destination}. Immediate: ${immediateOk} sent, ${immediateFailed} failed.`,
        });
      } else {
        setMessage({ type: "success", text: "Disabled ETA updates for all active driver groups." });
      }
    } catch (err) {
      setMessage({ type: "error", text: err.message });
    } finally {
      setTestingBulkSavingMode(null);
    }
  };

  const handleSaveGlobalIntervals = async () => {
    const driver = Number(globalDriverIntervalMin);
    const test = Number(globalTestIntervalMin);
    if (
      !Number.isInteger(driver) || driver < 1 || driver > 1440
      || !Number.isInteger(test) || test < 1 || test > 1440
    ) {
      setMessage({ type: "error", text: "Each global interval must be between 1 and 1440 minutes." });
      return;
    }
    setSavingGlobalIntervals(true);
    setMessage(null);
    try {
      await api.saveDispatchEtaGlobalIntervals({
        driverIntervalMinutes: driver,
        testIntervalMinutes: test,
      });
      setMessage({
        type: "success",
        text: "Global intervals saved and applied to every ETA row by target (driver vs test). Enable/disable stays unchanged.",
      });
      await loadTestingGroups();
    } catch (err) {
      setMessage({ type: "error", text: err.message });
    } finally {
      setSavingGlobalIntervals(false);
    }
  };

  return {
    testingGroups, dispatchEtaTestGroupId, testingLoading,
    testingSavingGroupId, testingBulkSavingMode,
    globalDriverIntervalMin, setGlobalDriverIntervalMin,
    globalTestIntervalMin, setGlobalTestIntervalMin, savingGlobalIntervals,
    loadTestingGroups, handleTestingToggle,
    handleTestingToggleAll, handleSaveGlobalIntervals,
  };
}
