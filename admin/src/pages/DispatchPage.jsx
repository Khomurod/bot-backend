import React, { useCallback, useEffect, useState } from "react";
import * as api from "../api";

const ACCEPTED_MIME_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

function getFileExtension(mimeType) {
  if (mimeType === "application/pdf") return "pdf";
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/webp") return "webp";
  return "bin";
}

function normalizeClipboardFile(file) {
  if (!file) return null;
  if (file.name) return file;
  return new File(
    [file],
    `clipboard-${Date.now()}.${getFileExtension(file.type)}`,
    { type: file.type || "application/octet-stream" }
  );
}

function formatGroupLabel(group) {
  const driverName = [group.driver_first_name, group.driver_last_name]
    .filter(Boolean)
    .join(" ");
  const namePart = driverName
    ? `${group.group_name} - ${driverName}`
    : group.group_name;
  return `${namePart} | ${group.telegram_group_id}`;
}

function stripRateLine(text) {
  return String(text || "")
    .split(/\r?\n/)
    .filter((line) => !/^Rate:\s*/i.test(line.trim()))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function resolveChatId(groupInput, groups) {
  const trimmed = String(groupInput || "").trim();
  if (!trimmed) return "";

  const exactMatch = groups.find(
    (group) =>
      group.label === trimmed ||
      group.group_name === trimmed ||
      String(group.telegram_group_id || "") === trimmed
  );
  if (exactMatch) {
    return String(exactMatch.telegram_group_id || "").trim();
  }

  const idMatch = trimmed.match(/(@[A-Za-z0-9_]+|-?\d+)\s*$/);
  return idMatch ? idMatch[1] : trimmed;
}

function formatIntervalText(intervalMinutes) {
  const safe = Number(intervalMinutes) > 0 ? Number(intervalMinutes) : 0;
  const hours = Math.floor(safe / 60);
  const minutes = safe % 60;
  return `${hours}h ${minutes}m`;
}

function normalizeEtaEnabled(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  if (typeof value === "number") return value === 1;
  return false;
}

function formatOptionalDateTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString();
}

export default function DispatchPage() {
  const [activeTab, setActiveTab] = useState("assistant");
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState(null);
  const [resultText, setResultText] = useState("");
  const [activeFileName, setActiveFileName] = useState("");
  const [sourceFile, setSourceFile] = useState(null);
  const [copying, setCopying] = useState(false);
  const [groups, setGroups] = useState([]);
  const [selectedGroupInput, setSelectedGroupInput] = useState("");
  const [withRate, setWithRate] = useState(true);
  const [withRateConfirmation, setWithRateConfirmation] = useState(true);
  const [testingGroups, setTestingGroups] = useState([]);
  const [dispatchEtaTestGroupId, setDispatchEtaTestGroupId] = useState("");
  const [testingLoading, setTestingLoading] = useState(false);
  const [testingSavingGroupId, setTestingSavingGroupId] = useState(null);
  const [testingBulkSavingMode, setTestingBulkSavingMode] = useState(null);
  const [expandedTestingGroupId, setExpandedTestingGroupId] = useState(null);
  const [testingDetailsByGroupId, setTestingDetailsByGroupId] = useState({});
  const [testingDetailsLoadingGroupId, setTestingDetailsLoadingGroupId] = useState(null);
  const [globalDriverIntervalMin, setGlobalDriverIntervalMin] = useState(60);
  const [globalTestIntervalMin, setGlobalTestIntervalMin] = useState(60);
  const [savingGlobalIntervals, setSavingGlobalIntervals] = useState(false);

  useEffect(() => {
    let isMounted = true;

    const loadGroups = async () => {
      try {
        const data = await api.getGroups();
        if (!isMounted) return;

        const rawGroups = Array.isArray(data) ? data : Array.isArray(data?.groups) ? data.groups : [];
        const managementGroupId = Array.isArray(data)
          ? ""
          : String(data?.managementGroupId || "").trim();

        const managementGroup = {
          id: "management-group",
          group_name: "Management Group",
          telegram_group_id: managementGroupId,
          driver_first_name: "",
          driver_last_name: "",
          label: managementGroupId
            ? `Management Group | ${managementGroupId}`
            : "Management Group | Paste chat ID manually",
        };

        const mappedGroups = rawGroups.map((group) => ({
          ...group,
          label: formatGroupLabel(group),
        }));

        const uniqueGroups = mappedGroups.filter(
          (group) => String(group.telegram_group_id || "") !== managementGroupId
        );
        const nextGroups = [managementGroup, ...uniqueGroups];

        setGroups(nextGroups);
        setSelectedGroupInput((current) => (
          current || (managementGroupId ? managementGroup.label : current)
        ));
      } catch (err) {
        if (!isMounted) return;
        setGroups([
          {
            id: "management-group",
            group_name: "Management Group",
            telegram_group_id: "",
            driver_first_name: "",
            driver_last_name: "",
            label: "Management Group | Paste chat ID manually",
          },
        ]);
      }
    };

    loadGroups();
    return () => {
      isMounted = false;
    };
  }, []);

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

  const loadTestingGroupDetails = useCallback(async (groupId, options = {}) => {
    const forceRefresh = Boolean(options.forceRefresh);
    if (!groupId) return;

    if (!forceRefresh && testingDetailsByGroupId[groupId]) {
      return;
    }

    setTestingDetailsLoadingGroupId(groupId);
    try {
      const data = await api.getDispatchTestingGroupDetails(groupId);
      setTestingDetailsByGroupId((current) => ({
        ...current,
        [groupId]: data?.details || { error: "No details available." },
      }));
    } catch (err) {
      setTestingDetailsByGroupId((current) => ({
        ...current,
        [groupId]: { error: err.message || "Failed to load group details." },
      }));
    } finally {
      setTestingDetailsLoadingGroupId((current) => (current === groupId ? null : current));
    }
  }, [testingDetailsByGroupId]);

  const uploadFile = useCallback(async (inputFile) => {
    const file = normalizeClipboardFile(inputFile);
    if (!file) return;

    if (!ACCEPTED_MIME_TYPES.has(file.type)) {
      setMessage({ type: "error", text: "Please upload a PDF, JPG, PNG, or WEBP file." });
      return;
    }

    setLoading(true);
    setMessage(null);
    setActiveFileName(file.name);
    setSourceFile(file);

    try {
      const data = await api.parseDispatchRateCon(file);
      setResultText(data.text || "");
      setMessage({ type: "success", text: "Rate confirmation parsed successfully." });
    } catch (err) {
      setMessage({ type: "error", text: err.message });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const handlePaste = (event) => {
      if (loading) return;

      const fileItem = Array.from(event.clipboardData?.items || []).find(
        (item) => item.kind === "file"
      );
      if (!fileItem) return;

      const pastedFile = fileItem.getAsFile();
      if (!pastedFile) return;

      event.preventDefault();
      uploadFile(pastedFile);
    };

    window.addEventListener("paste", handlePaste);
    return () => window.removeEventListener("paste", handlePaste);
  }, [loading, uploadFile]);

  const handleFileChange = async (event) => {
    const file = event.target.files?.[0];
    if (file) {
      await uploadFile(file);
    }
    event.target.value = "";
  };

  const handleCopy = async () => {
    if (!resultText) return;

    setCopying(true);
    try {
      await navigator.clipboard.writeText(resultText);
      setMessage({ type: "success", text: "Formatted load copied to clipboard." });
    } catch (err) {
      setMessage({ type: "error", text: "Copy failed. Please copy the text manually." });
    } finally {
      setCopying(false);
    }
  };

  const handleSendToTelegram = async () => {
    const chatId = resolveChatId(selectedGroupInput, groups);
    if (!chatId) {
      setMessage({ type: "error", text: "Select a group from the list or paste a valid Telegram chat ID." });
      return;
    }

    let finalText = resultText.trim();
    if (!finalText) {
      setMessage({ type: "error", text: "There is no parsed load text to send yet." });
      return;
    }

    if (!withRate) {
      finalText = stripRateLine(finalText);
    }

    const formData = new FormData();
    formData.append("chatId", chatId);
    formData.append("messageText", finalText);
    if (withRateConfirmation && sourceFile) {
      formData.append("document", sourceFile);
    }

    setSending(true);
    setMessage(null);

    try {
      await api.sendDispatchToTelegram(formData);
      setMessage({ type: "success", text: "Dispatch load sent to Telegram successfully." });
    } catch (err) {
      setMessage({ type: "error", text: err.message });
    } finally {
      setSending(false);
    }
  };

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
      setTestingDetailsByGroupId((current) => {
        const existing = current[row.group_id];
        if (!existing || existing.error) return current;
        return {
          ...current,
          [row.group_id]: {
            ...existing,
            settings: {
              ...existing.settings,
              enabled: normalizeEtaEnabled(saved.eta_enabled),
              intervalMinutes: Number(saved.eta_interval_minutes) || existing.settings?.intervalMinutes || 60,
              intervalHours: Number(saved.eta_interval_hours) || 0,
              intervalRemainingMinutes: Number(saved.eta_interval_remaining_minutes) || 0,
              nextRunAt: saved.eta_next_run_at || existing.settings?.nextRunAt || null,
              lastRunAt: saved.eta_last_run_at || existing.settings?.lastRunAt || null,
              lastStatus: saved.eta_last_status || existing.settings?.lastStatus || null,
              lastError: saved.eta_last_error || existing.settings?.lastError || null,
            },
          },
        };
      });

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

  const handleTestingExpand = async (row) => {
    if (!row?.group_id) return;
    const nextExpanded = expandedTestingGroupId === row.group_id ? null : row.group_id;
    setExpandedTestingGroupId(nextExpanded);
    if (nextExpanded) {
      await loadTestingGroupDetails(row.group_id);
    }
  };

  const handleRefreshTestingDetails = async (groupId) => {
    await loadTestingGroupDetails(groupId, { forceRefresh: true });
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

  const renderAssistantTab = () => (
    <div style={{ display: "grid", gap: "24px" }}>
      <div className="card">
        <div style={{ display: "grid", gap: "16px" }}>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label>Rate Confirmation File</label>
            <input
              type="file"
              className="form-input"
              accept="application/pdf,image/jpeg,image/png,image/webp"
              onChange={handleFileChange}
              disabled={loading}
            />
          </div>

          <div
            style={{
              padding: "14px 16px",
              borderRadius: "12px",
              border: "1px dashed var(--border)",
              background: "var(--bg-secondary)",
              color: "var(--text-secondary)",
              lineHeight: 1.5,
            }}
          >
            Press <strong>Ctrl+V</strong> anywhere on this page to upload a copied screenshot, picture, or PDF from your clipboard automatically.
          </div>

          {activeFileName && (
            <div style={{ color: "var(--text-secondary)", fontSize: "14px" }}>
              Current file: <strong style={{ color: "var(--text-primary)" }}>{activeFileName}</strong>
            </div>
          )}

          {loading && (
            <div className="loading" style={{ padding: "12px 0", justifyContent: "flex-start" }}>
              <div className="spinner"></div>
              Extracting text and formatting the load...
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: "12px",
            marginBottom: "16px",
            flexWrap: "wrap",
          }}
        >
          <div>
            <h3 style={{ marginBottom: "4px" }}>Formatted Dispatch Notes</h3>
            <p style={{ color: "var(--text-secondary)", fontSize: "14px" }}>
              Review and tweak the output before sending it to the dispatcher.
            </p>
          </div>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleCopy}
            disabled={!resultText || copying}
          >
            {copying ? "Copying..." : "Copy to Clipboard"}
          </button>
        </div>

        <textarea
          className="form-textarea"
          value={resultText}
          onChange={(event) => setResultText(event.target.value)}
          placeholder="The formatted load template will appear here after processing."
          style={{
            minHeight: "420px",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
            whiteSpace: "pre-wrap",
          }}
        />

        <div style={{ display: "grid", gap: "16px", marginTop: "24px" }}>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label>Telegram Group</label>
            <input
              type="text"
              className="form-input"
              list="dispatch-group-options"
              value={selectedGroupInput}
              onChange={(event) => setSelectedGroupInput(event.target.value)}
              placeholder="Search a group name or paste a chat ID"
            />
            <datalist id="dispatch-group-options">
              {groups.map((group) => (
                <option key={group.id || group.label} value={group.label} />
              ))}
            </datalist>
          </div>

          <div style={{ display: "flex", gap: "20px", flexWrap: "wrap" }}>
            <label style={{ display: "inline-flex", alignItems: "center", gap: "8px", color: "var(--text-secondary)" }}>
              <input
                type="checkbox"
                checked={withRate}
                onChange={(event) => setWithRate(event.target.checked)}
              />
              With Rate
            </label>
            <label style={{ display: "inline-flex", alignItems: "center", gap: "8px", color: "var(--text-secondary)" }}>
              <input
                type="checkbox"
                checked={withRateConfirmation}
                onChange={(event) => setWithRateConfirmation(event.target.checked)}
              />
              With Rate Confirmation
            </label>
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button
              type="button"
              className="btn btn-success"
              onClick={handleSendToTelegram}
              disabled={sending || !resultText.trim()}
            >
              {sending ? "Sending..." : "Send to Telegram"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  const renderTestingTab = () => (
    <div className="card">
      <div style={{ marginBottom: "16px" }}>
        <h3 style={{ marginBottom: "6px" }}>Testing Feature</h3>
        <p style={{ color: "var(--text-secondary)", fontSize: "14px" }}>
          Toggle periodic ETA updates per driver group. Turning a toggle on sends one immediate update, then repeats on the interval below.
          Global intervals apply to every row that targets driver chats vs the test chat; you can edit them anytime, including while updates are running.
        </p>
      </div>

      <div
        style={{
          marginBottom: "18px",
          padding: "14px 16px",
          borderRadius: "12px",
          border: "1px solid var(--border)",
          background: "var(--bg-primary)",
          display: "grid",
          gap: "12px",
        }}
      >
        <div style={{ fontWeight: 600 }}>Global ETA intervals (minutes)</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "16px", alignItems: "flex-end" }}>
          <div className="form-group" style={{ marginBottom: 0, minWidth: "200px" }}>
            <label>Driver group targets</label>
            <input
              type="number"
              className="form-input"
              min={1}
              max={1440}
              value={globalDriverIntervalMin}
              onChange={(e) => setGlobalDriverIntervalMin(Number(e.target.value))}
              disabled={testingLoading || savingGlobalIntervals}
            />
          </div>
          <div className="form-group" style={{ marginBottom: 0, minWidth: "200px" }}>
            <label>Test group targets</label>
            <input
              type="number"
              className="form-input"
              min={1}
              max={1440}
              value={globalTestIntervalMin}
              onChange={(e) => setGlobalTestIntervalMin(Number(e.target.value))}
              disabled={testingLoading || savingGlobalIntervals}
            />
          </div>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={handleSaveGlobalIntervals}
            disabled={testingLoading || savingGlobalIntervals || testingBulkSavingMode !== null}
          >
            {savingGlobalIntervals ? "Saving..." : "Save global intervals"}
          </button>
        </div>
        <div style={{ fontSize: "13px", color: "var(--text-secondary)" }}>
          Saving updates the defaults and sets <code style={{ fontSize: "12px" }}>interval_minutes</code> on all ETA rows:
          driver-mode rows use the first value, test-mode rows use the second (test chat:{" "}
          {dispatchEtaTestGroupId || "not configured"}).
        </div>
      </div>

      <div style={{ marginBottom: "14px" }}>
        <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={loadTestingGroups}
            disabled={testingLoading || testingBulkSavingMode !== null}
          >
            {testingLoading ? "Refreshing..." : "Refresh Groups"}
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => handleTestingToggleAll("driver", true)}
            disabled={testingBulkSavingMode !== null}
          >
            {testingBulkSavingMode === "driver" ? "Applying..." : "Enable ALL Driver groups"}
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => handleTestingToggleAll("test", true)}
            disabled={testingBulkSavingMode !== null || !dispatchEtaTestGroupId}
            title={dispatchEtaTestGroupId ? `Test group: ${dispatchEtaTestGroupId}` : "DISPATCH_ETA_TEST_GROUP_ID not configured"}
          >
            {testingBulkSavingMode === "test" ? "Applying..." : "Enable ALL Test group"}
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => handleTestingToggleAll("driver", false)}
            disabled={testingBulkSavingMode !== null}
          >
            Disable ALL
          </button>
        </div>
      </div>

      {testingLoading ? (
        <div className="loading" style={{ padding: "16px 0", justifyContent: "flex-start" }}>
          <div className="spinner"></div>
          Loading active driver groups...
        </div>
      ) : (
        <div style={{ display: "grid", gap: "10px" }}>
          {testingGroups.length === 0 && (
            <div style={{ color: "var(--text-secondary)" }}>No active driver groups found.</div>
          )}

          {testingGroups.map((row) => {
            const saving = testingSavingGroupId === row.group_id;
            const driverEnabled = normalizeEtaEnabled(row.eta_enabled_driver ?? (row.eta_enabled && row.eta_target_mode !== "test"));
            const testEnabled = normalizeEtaEnabled(row.eta_enabled_test ?? (row.eta_enabled && row.eta_target_mode === "test"));
            const expanded = expandedTestingGroupId === row.group_id;
            const detailsLoading = testingDetailsLoadingGroupId === row.group_id;
            const details = testingDetailsByGroupId[row.group_id];
            const detailsError = details && details.error;
            return (
              <div
                key={row.group_id}
                style={{
                  border: "1px solid var(--border)",
                  borderRadius: "12px",
                  padding: "12px 14px",
                  display: "grid",
                  gap: "8px",
                  background: "var(--bg-secondary)",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", gap: "10px", flexWrap: "wrap", alignItems: "center" }}>
                  <div>
                    <div style={{ fontWeight: 600 }}>{row.group_name}</div>
                    <div style={{ color: "var(--text-secondary)", fontSize: "13px" }}>
                      {row.telegram_group_id}
                    </div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => handleTestingExpand(row)}
                    >
                      {expanded ? "Hide details" : "Show details"}
                    </button>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={driverEnabled}
                      aria-label={`Toggle driver-group ETA updates for ${row.group_name}`}
                      onClick={() => handleTestingToggle(row, "driver", !driverEnabled)}
                      disabled={saving}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "8px",
                        border: "none",
                        background: "transparent",
                        color: "var(--text-secondary)",
                        cursor: saving ? "not-allowed" : "pointer",
                        padding: 0,
                      }}
                    >
                      <span style={{ fontSize: "12px" }}>Driver group</span>
                      <span
                        style={{
                          width: "42px",
                          height: "24px",
                          borderRadius: "999px",
                          background: driverEnabled ? "var(--success)" : "var(--border)",
                          position: "relative",
                          transition: "background 150ms ease",
                          opacity: saving ? 0.7 : 1,
                        }}
                      >
                        <span
                          style={{
                            position: "absolute",
                            top: "3px",
                            left: driverEnabled ? "21px" : "3px",
                            width: "18px",
                            height: "18px",
                            borderRadius: "50%",
                            background: "#fff",
                            boxShadow: "0 1px 2px rgba(0,0,0,0.25)",
                            transition: "left 150ms ease",
                          }}
                        />
                      </span>
                      {saving && driverEnabled ? "Saving..." : (driverEnabled ? "On" : "Off")}
                    </button>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={testEnabled}
                      aria-label={`Toggle test-group ETA updates for ${row.group_name}`}
                      onClick={() => handleTestingToggle(row, "test", !testEnabled)}
                      disabled={saving || !dispatchEtaTestGroupId}
                      title={dispatchEtaTestGroupId ? `Test group: ${dispatchEtaTestGroupId}` : "DISPATCH_ETA_TEST_GROUP_ID not configured"}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "8px",
                        border: "none",
                        background: "transparent",
                        color: "var(--text-secondary)",
                        cursor: saving || !dispatchEtaTestGroupId ? "not-allowed" : "pointer",
                        padding: 0,
                        opacity: dispatchEtaTestGroupId ? 1 : 0.6,
                      }}
                    >
                      <span style={{ fontSize: "12px" }}>Test group</span>
                      <span
                        style={{
                          width: "42px",
                          height: "24px",
                          borderRadius: "999px",
                          background: testEnabled ? "var(--success)" : "var(--border)",
                          position: "relative",
                          transition: "background 150ms ease",
                          opacity: saving ? 0.7 : 1,
                        }}
                      >
                        <span
                          style={{
                            position: "absolute",
                            top: "3px",
                            left: testEnabled ? "21px" : "3px",
                            width: "18px",
                            height: "18px",
                            borderRadius: "50%",
                            background: "#fff",
                            boxShadow: "0 1px 2px rgba(0,0,0,0.25)",
                            transition: "left 150ms ease",
                          }}
                        />
                      </span>
                      {saving && testEnabled ? "Saving..." : (testEnabled ? "On" : "Off")}
                    </button>
                  </div>
                </div>

                <div style={{ display: "flex", gap: "14px", flexWrap: "wrap", color: "var(--text-secondary)", fontSize: "13px" }}>
                  <span>Interval: {formatIntervalText(row.eta_interval_minutes)}</span>
                  <span>Status: {row.eta_last_status || "idle"}</span>
                  <span>Next run: {row.eta_next_run_at ? new Date(row.eta_next_run_at).toLocaleString() : "-"}</span>
                </div>

                {row.eta_last_error && (
                  <div style={{ color: "var(--danger)", fontSize: "13px" }}>
                    Last error: {row.eta_last_error}
                  </div>
                )}

                {expanded && (
                  <div
                    style={{
                      marginTop: "6px",
                      paddingTop: "10px",
                      borderTop: "1px solid var(--border)",
                      display: "grid",
                      gap: "10px",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", gap: "10px", flexWrap: "wrap", alignItems: "center" }}>
                      <strong>Driver Diagnostics</strong>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => handleRefreshTestingDetails(row.group_id)}
                        disabled={detailsLoading}
                      >
                        {detailsLoading ? "Refreshing..." : "Refresh details"}
                      </button>
                    </div>

                    {detailsLoading ? (
                      <div className="loading" style={{ justifyContent: "flex-start" }}>
                        <div className="spinner"></div>
                        Loading diagnostics...
                      </div>
                    ) : detailsError ? (
                      <div style={{ color: "var(--danger)", fontSize: "13px" }}>
                        {detailsError}
                      </div>
                    ) : details ? (
                      <>
                        <div style={{ fontSize: "13px", color: "var(--text-secondary)" }}>
                          <strong style={{ color: "var(--text-primary)" }}>Current load:</strong>{" "}
                          {details.pinned?.available ? "Pinned message found" : "No pinned message found"}
                          {details.pinned?.pinnedMessageId ? ` (ID: ${details.pinned.pinnedMessageId})` : ""}
                          {details.pinned?.source ? ` via ${details.pinned.source}` : ""}
                        </div>

                        {details.pinned?.preview && (
                          <div style={{ fontSize: "13px", color: "var(--text-secondary)" }}>
                            Pinned preview: {details.pinned.preview}
                          </div>
                        )}
                        {details.pinned?.pickupSummary && (
                          <div style={{ fontSize: "13px", color: "var(--text-secondary)" }}>
                            Pickup: {details.pinned.pickupSummary}
                          </div>
                        )}
                        {details.pinned?.deliverySummary && (
                          <div style={{ fontSize: "13px", color: "var(--text-secondary)" }}>
                            Delivery: {details.pinned.deliverySummary}
                          </div>
                        )}
                        {details.pinned?.destinationQuery && (
                          <div style={{ fontSize: "13px", color: "var(--text-secondary)" }}>
                            Destination query: {details.pinned.destinationQuery}
                          </div>
                        )}
                        {details.pinned?.parseModel && (
                          <div style={{ fontSize: "13px", color: "var(--text-secondary)" }}>
                            Pinned parser model: {details.pinned.parseModel}
                          </div>
                        )}
                        {details.pinned?.parseError && (
                          <div style={{ fontSize: "13px", color: "var(--danger)" }}>
                            Pinned parser error: {details.pinned.parseError}
                          </div>
                        )}

                        <div style={{ fontSize: "13px", color: "var(--text-secondary)", marginTop: "6px" }}>
                          <strong style={{ color: "var(--text-primary)" }}>Last ingested loads (chat listener, max 2)</strong>
                          <div style={{ marginTop: "6px", fontSize: "12px", lineHeight: 1.45 }}>
                            Saved automatically when dispatch sends PDF/image/photo or load-style text—does not require a pinned message.
                          </div>
                        </div>

                        {Array.isArray(details.recentLoads) && details.recentLoads.length > 0 ? (
                          <div style={{ display: "grid", gap: "10px" }}>
                            {details.recentLoads.map((load) => (
                              <div
                                key={load.id ?? load.telegramMessageId}
                                style={{
                                  border: "1px solid var(--border)",
                                  borderRadius: "10px",
                                  padding: "10px 12px",
                                  background: "var(--bg-primary)",
                                  fontSize: "13px",
                                  color: "var(--text-secondary)",
                                }}
                              >
                                <div style={{ fontWeight: 600, color: "var(--text-primary)", marginBottom: "6px" }}>
                                  Telegram msg #{load.telegramMessageId}
                                  {load.loadIdentifier ? ` · Load ${load.loadIdentifier}` : ""}
                                  {load.createdAt ? (
                                    <span style={{ fontWeight: 400, color: "var(--text-secondary)" }}>
                                      {" "}
                                      · saved {formatOptionalDateTime(load.createdAt)}
                                    </span>
                                  ) : null}
                                </div>
                                {load.captionPreview ? (
                                  <div style={{ marginBottom: "6px" }}>
                                    <strong style={{ color: "var(--text-primary)" }}>Caption:</strong>{" "}
                                    {load.captionPreview.length > 280 ? `${load.captionPreview.slice(0, 280)}…` : load.captionPreview}
                                  </div>
                                ) : null}
                                {load.pickupSummary ? (
                                  <div>
                                    <strong style={{ color: "var(--text-primary)" }}>Pickup:</strong> {load.pickupSummary}
                                  </div>
                                ) : null}
                                {load.deliverySummary ? (
                                  <div>
                                    <strong style={{ color: "var(--text-primary)" }}>Delivery:</strong> {load.deliverySummary}
                                  </div>
                                ) : null}
                                {load.destinationQuery ? (
                                  <div>
                                    <strong style={{ color: "var(--text-primary)" }}>Destination (routing):</strong>{" "}
                                    {load.destinationQuery}
                                  </div>
                                ) : null}
                                <div style={{ marginTop: "6px", fontSize: "12px", opacity: 0.9 }}>
                                  {(load.pickupWindowStart || load.pickupWindowEnd || load.deliveryWindowStart || load.deliveryWindowEnd) ? (
                                    <>
                                      <strong style={{ color: "var(--text-primary)" }}>Windows (parsed):</strong> PU{" "}
                                      {formatOptionalDateTime(load.pickupWindowStart)}
                                      {" → "}
                                      {formatOptionalDateTime(load.pickupWindowEnd)}
                                      {" · DEL "}
                                      {formatOptionalDateTime(load.deliveryWindowStart)}
                                      {" → "}
                                      {formatOptionalDateTime(load.deliveryWindowEnd)}
                                    </>
                                  ) : (
                                    <span>No appointment windows parsed (fallback: newest load wins).</span>
                                  )}
                                </div>
                                {load.aiModel ? (
                                  <div style={{ marginTop: "4px", fontSize: "12px" }}>
                                    Model: {load.aiModel}
                                  </div>
                                ) : null}
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div style={{ fontSize: "13px", color: "var(--text-secondary)", fontStyle: "italic" }}>
                            No loads ingested yet for this group (send a rate con / load message while the bot is online).
                          </div>
                        )}

                        <div style={{ fontSize: "13px", color: "var(--text-secondary)" }}>
                          <strong style={{ color: "var(--text-primary)" }}>Current location:</strong>{" "}
                          {details.location?.available
                            ? `${details.location.address || `${details.location.latitude}, ${details.location.longitude}`} (${details.location.source})`
                            : `Unavailable${details.location?.error ? ` - ${details.location.error}` : ""}`}
                        </div>

                        {details.location?.available && (
                          <div style={{ display: "flex", gap: "14px", flexWrap: "wrap", color: "var(--text-secondary)", fontSize: "13px" }}>
                            <span>Unit: {details.location.unitNumber || "-"}</span>
                            <span>Vehicle: {details.location.vehicleName || "-"}</span>
                            <span>
                              Coords: {Number.isFinite(details.location.latitude) ? details.location.latitude.toFixed(6) : "-"},{" "}
                              {Number.isFinite(details.location.longitude) ? details.location.longitude.toFixed(6) : "-"}
                            </span>
                            <span>Last ping: {details.location.pingAgeMinutes ?? "-"} min</span>
                          </div>
                        )}

                        <div style={{ fontSize: "13px", color: "var(--text-secondary)" }}>
                          <strong style={{ color: "var(--text-primary)" }}>Device status:</strong>
                        </div>
                        <div style={{ display: "grid", gap: "6px" }}>
                          {(details.providers || []).map((provider) => (
                            <div key={provider.label} style={{ fontSize: "13px", color: "var(--text-secondary)" }}>
                              {provider.label}:{" "}
                              <strong style={{ color: provider.connected ? "var(--success)" : "var(--danger)" }}>
                                {provider.connected ? "Connected" : "Not Connected"}
                              </strong>
                              {provider.error ? ` (${provider.error})` : ""}
                            </div>
                          ))}
                        </div>

                        <div style={{ fontSize: "13px", color: "var(--text-secondary)" }}>
                          <strong style={{ color: "var(--text-primary)" }}>ETA:</strong>{" "}
                          {details.eta?.available
                            ? `${details.eta.remainingMiles} mi, ${details.eta.etaMinutes} min (around ${details.eta.etaChicagoLabel} CT)`
                            : `Unavailable${details.eta?.error ? ` - ${details.eta.error}` : ""}`}
                        </div>
                        {details.eta?.destinationDisplayName && (
                          <div style={{ fontSize: "13px", color: "var(--text-secondary)" }}>
                            ETA destination: {details.eta.destinationDisplayName}
                          </div>
                        )}

                        <div style={{ display: "flex", gap: "14px", flexWrap: "wrap", color: "var(--text-secondary)", fontSize: "13px" }}>
                          <span>
                            Auto Update:{" "}
                            <strong style={{ color: row.eta_enabled ? "var(--success)" : "var(--text-secondary)" }}>
                              {row.eta_enabled ? "On" : "Off"}
                            </strong>
                          </span>
                          <span>Interval: {formatIntervalText(row.eta_interval_minutes)}</span>
                          <span>Next run: {formatOptionalDateTime(row.eta_next_run_at)}</span>
                        </div>
                      </>
                    ) : (
                      <div style={{ color: "var(--text-secondary)", fontSize: "13px" }}>
                        No diagnostics loaded yet.
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );

  return (
    <div>
      <div className="page-header">
        <h2>Dispatch Assistant</h2>
        <p>Upload or paste a rate confirmation PDF or image and get a dispatcher-ready template.</p>
      </div>

      {message && (
        <div className={`alert alert-${message.type}`}>
          {message.text}
        </div>
      )}

      <div style={{ display: "flex", gap: "10px", marginBottom: "20px", flexWrap: "wrap" }}>
        <button
          type="button"
          className={`btn ${activeTab === "assistant" ? "btn-primary" : "btn-ghost"}`}
          onClick={() => setActiveTab("assistant")}
        >
          Dispatch Assistant
        </button>
        <button
          type="button"
          className={`btn ${activeTab === "testing" ? "btn-primary" : "btn-ghost"}`}
          onClick={() => setActiveTab("testing")}
        >
          Testing Feature
        </button>
      </div>

      {activeTab === "assistant" ? renderAssistantTab() : renderTestingTab()}
    </div>
  );
}
