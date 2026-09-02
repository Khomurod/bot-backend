import { useState } from "react";
import * as api from "../../api";

/**
 * Driver Raise settings: the enable switch, the verification-code channel, the
 * weekly auto-send schedule, the two per-mile rates and the link lifetime —
 * plus the Gmail credentials used when the channel is email.
 *
 * Every field saves on change or blur; there is no explicit Save for the
 * settings themselves, so each write goes through saveSettings() and reports
 * through the page's shared flash().
 *
 * The Gmail App Password is WRITE-ONLY: the API returns only
 * `gmail_configured`, never the value, so leaving the field blank on save keeps
 * whatever is stored.
 *
 * Split out of admin/src/pages/RaiseApprovalPage.jsx.
 */
export function useRaiseSettings(flash, clearStatus) {
  const [settings, setSettings] = useState(null);
  const [scheduleDescription, setScheduleDescription] = useState("");
  const [savingSettings, setSavingSettings] = useState(false);
  const [gmailUser, setGmailUser] = useState("");
  const [gmailPassword, setGmailPassword] = useState("");
  const [savingGmail, setSavingGmail] = useState(false);

  /** Fetch and apply the settings row. Called by the page's batched load. */
  const load = async () => {
    const s = await api.getRaiseSettings();
    setSettings(s.settings);
    setScheduleDescription(s.scheduleDescription);
    setGmailUser(s.settings.gmail_user || "");
  };

  const saveSettings = async (patch) => {
    setSavingSettings(true);
    clearStatus();
    try {
      const res = await api.updateRaiseSettings(patch);
      setSettings(res.settings);
      setScheduleDescription(res.scheduleDescription);
      flash("success", "Settings saved.");
    } catch (err) {
      flash("error", err.message);
    } finally {
      setSavingSettings(false);
    }
  };

  const saveGmail = async () => {
    if (!gmailUser.trim()) return flash("error", "Enter your Gmail address.");
    setSavingGmail(true);
    clearStatus();
    try {
      const res = await api.updateRaiseSettings({
        gmail_user: gmailUser.trim(),
        ...(gmailPassword.trim() ? { gmail_app_password: gmailPassword.trim() } : {}),
      });
      setSettings(res.settings);
      setScheduleDescription(res.scheduleDescription);
      setGmailPassword("");
      flash("success", "Email settings saved.");
    } catch (err) {
      flash("error", err.message);
    } finally {
      setSavingGmail(false);
    }
  };

  return {
    settings, scheduleDescription, savingSettings, saveSettings,
    gmailUser, setGmailUser, gmailPassword, setGmailPassword,
    savingGmail, saveGmail, load,
  };
}
