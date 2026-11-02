import { useCallback, useEffect, useState } from "react";
import * as api from "../../../api";

/**
 * The shared RingCentral settings row: read, and saved PART BY PART.
 *
 * Until November 2026 one screen edited all of it — the credentials, the
 * monitoring switch, the KPI targets and thresholds — and Save sent every
 * field. It is now edited from two places: Settings → RingCentral Connection
 * (credentials, switch, poll interval) and Recruiter KPIs → Targets (targets,
 * thresholds, the KPI day's timezone). Each sends ONLY its own fields, which
 * the server already allows (`updateRcSettings` skips a field that is absent),
 * so neither can save a stale copy of the other's values over a newer one.
 *
 * A read that fails, or answers with no settings, is a failure the caller
 * shows with a retry INSTEAD of a form: a form drawn from defaults could save
 * them over the stored values.
 */
export default function useRingCentralSettings() {
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const s = await api.getRingCentralSettings();
      if (!s || typeof s !== "object") throw new Error("The server did not send the RingCentral settings.");
      setSettings(s);
    } catch (err) {
      setSettings(null);
      setLoadError(err);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  /** Save `payload` (only the fields given) and keep what the server answers. */
  const save = useCallback(async (payload) => {
    const s = await api.updateRingCentralSettings(payload);
    setSettings(s);
    return s;
  }, []);

  return { settings, loading, loadError, load, save };
}
