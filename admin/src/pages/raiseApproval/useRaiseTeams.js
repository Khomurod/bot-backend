import { useState } from "react";
import * as api from "../../api";

/**
 * The dispatch teams that get asked which drivers earned the raise.
 *
 * Every mutation re-fetches the whole list rather than patching local state,
 * because a team row carries server-computed driver and member counts that the
 * driver/member panels change from underneath this hook.
 *
 * Split out of admin/src/pages/RaiseApprovalPage.jsx.
 */
export function useRaiseTeams(flash) {
  const [teams, setTeams] = useState([]);
  const [newTeamName, setNewTeamName] = useState("");

  /** Fetch and apply the team list. Called by the page's batched load. */
  const load = async () => {
    const t = await api.getRaiseTeams();
    setTeams(t.teams || []);
  };

  const refreshTeams = load;

  const createTeam = async () => {
    const name = newTeamName.trim();
    if (!name) return;
    try {
      await api.createRaiseTeam(name);
      setNewTeamName("");
      await refreshTeams();
      flash("success", `Team "${name}" created.`);
    } catch (err) {
      flash("error", err.message);
    }
  };

  const toggleTeamActive = async (team) => {
    try {
      await api.updateRaiseTeam(team.id, { active: !team.active });
      await refreshTeams();
    } catch (err) {
      flash("error", err.message);
    }
  };

  const deleteTeam = async (team) => {
    if (!window.confirm(`Delete team "${team.name}"? This removes its driver assignments.`)) return;
    try {
      await api.deleteRaiseTeam(team.id);
      await refreshTeams();
      flash("success", "Team deleted.");
    } catch (err) {
      flash("error", err.message);
    }
  };

  return {
    teams, newTeamName, setNewTeamName,
    createTeam, toggleTeamActive, deleteTeam, refreshTeams, load,
  };
}
