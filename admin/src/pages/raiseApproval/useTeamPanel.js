import { useState } from "react";
import * as api from "../../api";

/**
 * The slide-in panel over a single team — one hook because it has one
 * `managingTeam` and two modes ("drivers" / "members") that are mutually
 * exclusive and share the same close action.
 *
 * DRIVER ASSIGNMENT IS EXCLUSIVE. A driver belongs to at most one dispatch
 * team, so assigning one who is already assigned comes back as a `conflict`
 * rather than silently moving them; the panel then asks, and only a confirmed
 * retry with force:true moves the driver. Preserving that two-step is the
 * point of `pendingConflict`.
 *
 * Driver Groups are the source of truth for who exists — candidates are always
 * fetched from the server rather than filtered client-side, so a newly added
 * driver appears without a reload.
 *
 * refreshTeams is injected because both panels change the per-team counts the
 * teams list displays.
 *
 * Split out of admin/src/pages/RaiseApprovalPage.jsx.
 */
export function useTeamPanel(flash, clearStatus, refreshTeams) {
  const [managingTeam, setManagingTeam] = useState(null);
  const [panelMode, setPanelMode] = useState(null); // 'drivers' | 'members'
  const [assignedDrivers, setAssignedDrivers] = useState([]);
  const [candidates, setCandidates] = useState([]);
  const [candidateSearch, setCandidateSearch] = useState("");
  const [candidatesLoading, setCandidatesLoading] = useState(false);
  const [pendingConflict, setPendingConflict] = useState(null); // { candidate, conflictTeam }
  const [members, setMembers] = useState([]);
  const [memberForm, setMemberForm] = useState({ name: "", telegram_username: "", role: "" });

  const loadCandidates = async (search = "") => {
    setCandidatesLoading(true);
    try {
      const res = await api.getRaiseAssignableDrivers({ search });
      setCandidates(res.drivers || []);
    } catch (err) {
      flash("error", err.message);
    } finally {
      setCandidatesLoading(false);
    }
  };

  const openDriverManager = async (team) => {
    clearStatus();
    setPendingConflict(null);
    try {
      const assigned = await api.getRaiseTeamDrivers(team.id);
      setAssignedDrivers(assigned.drivers || []);
      setManagingTeam(team);
      setPanelMode("drivers");
      setCandidateSearch("");
      await loadCandidates("");
    } catch (err) {
      flash("error", err.message);
    }
  };

  const refreshDriverPanel = async () => {
    if (!managingTeam) return;
    const assigned = await api.getRaiseTeamDrivers(managingTeam.id);
    setAssignedDrivers(assigned.drivers || []);
    await loadCandidates(candidateSearch);
    await refreshTeams();
  };

  const assignCandidate = async (candidate, force = false) => {
    if (!managingTeam) return;
    try {
      const res = await api.assignRaiseDriver(managingTeam.id, {
        groupId: candidate.group_id,
        driverProfileId: candidate.driver_profile_id,
        force,
      });
      // Already on another team: ask before moving, never move implicitly.
      if (res.conflict) {
        setPendingConflict({ candidate, conflictTeam: res.conflictTeam });
        return;
      }
      setPendingConflict(null);
      await refreshDriverPanel();
      flash("success", res.moved
        ? `Moved ${candidate.driver_name} to ${managingTeam.name}.`
        : `Assigned ${candidate.driver_name}.`);
    } catch (err) {
      flash("error", err.message);
    }
  };

  const removeAssignedDriver = async (driver) => {
    try {
      await api.removeRaiseTeamDriver(driver.id);
      await refreshDriverPanel();
      flash("success", `Removed ${driver.driver_name}.`);
    } catch (err) {
      flash("error", err.message);
    }
  };

  const openMembersManager = async (team) => {
    clearStatus();
    try {
      const res = await api.getRaiseTeamMembers(team.id);
      setMembers(res.members || []);
      setMemberForm({ name: "", telegram_username: "", role: "" });
      setManagingTeam(team);
      setPanelMode("members");
    } catch (err) {
      flash("error", err.message);
    }
  };

  const refreshMembers = async () => {
    if (!managingTeam) return;
    const res = await api.getRaiseTeamMembers(managingTeam.id);
    setMembers(res.members || []);
    await refreshTeams();
  };

  const addMember = async () => {
    if (!managingTeam) return;
    if (!memberForm.name.trim() && !memberForm.telegram_username.trim()) {
      return flash("error", "Enter a name or a Telegram username.");
    }
    try {
      await api.createRaiseTeamMember(managingTeam.id, {
        name: memberForm.name.trim() || null,
        telegramUsername: memberForm.telegram_username.trim() || null,
        role: memberForm.role || null,
      });
      setMemberForm({ name: "", telegram_username: "", role: "" });
      await refreshMembers();
      flash("success", "Member added.");
    } catch (err) {
      flash("error", err.message);
    }
  };

  const toggleMemberActive = async (member) => {
    try {
      await api.updateRaiseTeamMember(member.id, { active: !member.active });
      await refreshMembers();
    } catch (err) {
      flash("error", err.message);
    }
  };

  const removeMember = async (member) => {
    if (!window.confirm("Remove this team member?")) return;
    try {
      await api.deleteRaiseTeamMember(member.id);
      await refreshMembers();
      flash("success", "Member removed.");
    } catch (err) {
      flash("error", err.message);
    }
  };

  const closePanel = () => {
    setManagingTeam(null);
    setPanelMode(null);
    setPendingConflict(null);
  };

  return {
    managingTeam, panelMode, closePanel,
    assignedDrivers, candidates, candidateSearch, setCandidateSearch, candidatesLoading,
    pendingConflict, setPendingConflict,
    loadCandidates, openDriverManager, assignCandidate, removeAssignedDriver,
    members, memberForm, setMemberForm,
    openMembersManager, addMember, toggleMemberActive, removeMember,
  };
}
