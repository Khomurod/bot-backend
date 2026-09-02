import { useState, useEffect, useCallback, useMemo } from "react";
import * as api from "../../api";
import {
  isDriverActive, prepareDisplayProfiles, profileToDraft,
  normalizeManualUsername, isValidManualUsername, memberOptionLabel,
} from "./driverProfileShaping";

/**
 * Driver Groups data: the profile list, one editable draft per profile, the
 * per-group Telegram member cache, and the three ways a driver gets linked to
 * a Telegram identity.
 *
 * EVERY WRITE RE-FETCHES. saveProfilePatch reloads the whole list rather than
 * patching a row, because the server derives fields the panel shows —
 * duplicate_conflict, needs_review, status_source — from the write, and a
 * locally patched row would keep displaying the pre-write verdict.
 *
 * Members are cached PER GROUP and loaded only for the profile whose modal is
 * open: the member list is a separate query per group, so loading them all up
 * front would be one request per driver group on page load.
 *
 * Split out of admin/src/pages/GroupsPage.jsx.
 */
export function useDriverProfiles() {
  const [allProfiles, setAllProfiles] = useState([]);
  const [draftsById, setDraftsById] = useState({});
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState(null);
  const [savingProfileId, setSavingProfileId] = useState(null);
  const [syncingAi, setSyncingAi] = useState(false);
  const [activeTab, setActiveTab] = useState("all");
  const [statusSort, setStatusSort] = useState("active-first");
  const [openProfileId, setOpenProfileId] = useState(null);
  const [membersByGroup, setMembersByGroup] = useState({});

  const fetchProfiles = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.getDriverProfiles({ includeInactive: true });
      const profiles = Array.isArray(data) ? data : [];
      setAllProfiles(profiles);
      const nextDrafts = {};
      for (const profile of profiles) {
        nextDrafts[profile.id] = profileToDraft(profile);
      }
      setDraftsById(nextDrafts);
    } catch (err) {
      setMessage({ type: "error", text: err.message });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchProfiles();
  }, [fetchProfiles]);

  const displayProfiles = useMemo(
    () => prepareDisplayProfiles(allProfiles, activeTab, activeTab === "all" ? statusSort : null),
    [allProfiles, activeTab, statusSort],
  );

  const openProfile = useMemo(
    () => allProfiles.find((p) => p.id === openProfileId) || null,
    [allProfiles, openProfileId],
  );

  const loadGroupMembers = useCallback(async (groupId) => {
    setMembersByGroup((prev) => ({
      ...prev,
      [groupId]: { ...(prev[groupId] || {}), loading: true, error: null },
    }));
    try {
      const list = await api.getGroupMembers(groupId);
      setMembersByGroup((prev) => ({
        ...prev,
        [groupId]: { list, loading: false, error: null },
      }));
    } catch (err) {
      setMembersByGroup((prev) => ({
        ...prev,
        [groupId]: { list: [], loading: false, error: err.message },
      }));
    }
  }, []);

  useEffect(() => {
    if (openProfile?.group_id) loadGroupMembers(openProfile.group_id);
  }, [openProfile?.group_id, loadGroupMembers]);

  const updateDraft = (profileId, patch) => {
    setDraftsById((prev) => ({
      ...prev,
      [profileId]: {
        ...(prev[profileId] || {}),
        ...patch,
      },
    }));
  };

  const saveProfilePatch = async (profile, patch, successText) => {
    setSavingProfileId(profile.id);
    setMessage(null);
    try {
      await api.updateDriverProfile(profile.id, patch);
      setMessage({ type: "success", text: successText });
      await fetchProfiles();
    } catch (err) {
      setMessage({ type: "error", text: err.message });
    } finally {
      setSavingProfileId(null);
    }
  };

  const toggleStatusSort = () => {
    setStatusSort((s) => (s === "active-first" ? "inactive-first" : "active-first"));
  };

  const handleAiSync = async () => {
    if (!window.confirm(
      "Run one smart AI pass that re-reads every driver group title, fills names, team-driver fields, unit number, type, "
      + "and status where they are not manually locked?"
    )) return;
    setSyncingAi(true);
    setMessage(null);
    try {
      const result = await api.runDriverProfilesAiSync(true);
      setMessage({
        type: "success",
        text: `AI sync finished: ${result.updated ?? 0} of ${result.total ?? 0} driver groups enriched.`,
      });
      await fetchProfiles();
    } catch (err) {
      setMessage({ type: "error", text: err.message });
    } finally {
      setSyncingAi(false);
    }
  };

  // Selecting a captured member makes them the single source of truth for the
  // driver: BOTH their numeric telegram_user_id and username are stored on the
  // driver_profiles row (empty selection clears both).
  const handleMemberSelect = (profile, memberId) => {
    const cache = membersByGroup[profile.group_id];
    const member = (cache?.list || []).find((m) => m.telegram_user_id === memberId) || null;
    saveProfilePatch(
      profile,
      {
        telegram_user_id: member ? member.telegram_user_id : null,
        telegram_username: member ? member.username : null,
      },
      member
        ? `Driver linked to ${memberOptionLabel(member)}.`
        : "Driver Telegram link cleared.",
    );
  };

  // Manual @username entry — for a driver the bot has not seen text yet. Saves
  // the username only (the server stores it normalized, without the '@'). A
  // numeric id is NOT required; when the username differs from any stored
  // selection we drop the old numeric id so a stale id can't tag the wrong
  // person — the bot re-links the id automatically the next time that username
  // texts in the group (see db.backfillDriverProfileTelegramUserId).
  const handleManualUsernameSave = (profile, rawValue) => {
    const cleaned = normalizeManualUsername(rawValue);
    if (!cleaned) {
      setMessage({ type: "error", text: "Enter a Telegram username first." });
      return;
    }
    if (!isValidManualUsername(cleaned)) {
      setMessage({
        type: "error",
        text: "Username must be 3–32 characters: letters, numbers, or underscore.",
      });
      return;
    }
    const sameAsStored = String(profile.telegram_username || "").toLowerCase() === cleaned.toLowerCase();
    saveProfilePatch(
      profile,
      {
        telegram_username: cleaned,
        // Keep an already-linked id only when it belongs to this same username.
        ...(sameAsStored ? {} : { telegram_user_id: null }),
      },
      `Driver username set to @${cleaned}.`,
    );
  };

  const handleClearTelegram = (profile) => {
    saveProfilePatch(
      profile,
      { telegram_user_id: null, telegram_username: null },
      "Driver Telegram link cleared.",
    );
  };

  const tabCounts = useMemo(() => ({
    all: allProfiles.length,
    active: allProfiles.filter((p) => isDriverActive(p)).length,
    inactive: allProfiles.filter((p) => !isDriverActive(p)).length,
  }), [allProfiles]);

  return {
    allProfiles, draftsById, loading, message, savingProfileId, syncingAi,
    activeTab, setActiveTab, statusSort, toggleStatusSort,
    openProfileId, setOpenProfileId, openProfile, membersByGroup,
    displayProfiles, tabCounts,
    updateDraft, saveProfilePatch, handleAiSync,
    handleMemberSelect, handleManualUsernameSave, handleClearTelegram,
  };
}
