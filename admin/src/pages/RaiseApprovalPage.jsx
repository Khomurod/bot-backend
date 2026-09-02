import React from "react";
import { useRaiseApproval } from "./raiseApproval/useRaiseApproval";
import { SettingsCard } from "./raiseApproval/SettingsCard";
import { TeamsCard } from "./raiseApproval/TeamsCard";
import { DriverAssignmentPanel } from "./raiseApproval/DriverAssignmentPanel";
import { TeamMembersPanel } from "./raiseApproval/TeamMembersPanel";
import { SendReviewCard } from "./raiseApproval/SendReviewCard";
import { RoundsCard } from "./raiseApproval/RoundsCard";

/**
 * Driver Raises — page container.
 *
 * LAYOUT AND WIRING ONLY. All state and every API call live in
 * ./raiseApproval/useRaiseApproval.js and the four per-concern hooks it
 * composes; each card below is presentational and receives exactly one hook's
 * bundle, which is what keeps this from becoming a prop-drilling tree.
 *
 *   ./raiseApproval/useRaiseApproval.js  status banner + the batched load
 *   ./raiseApproval/useRaiseSettings.js  rates, schedule, OTP channel, Gmail
 *   ./raiseApproval/useRaiseTeams.js     the dispatch teams
 *   ./raiseApproval/useTeamPanel.js      the one panel, in its two modes
 *   ./raiseApproval/useRaiseRounds.js    send now, past rounds, results
 *
 * The two panels are mutually exclusive on purpose: one `managingTeam` at a
 * time, so a driver assignment can never be applied to the team whose members
 * are on screen.
 */
export default function RaiseApprovalPage() {
  const { loading, status, settings, teams, panel, rounds } = useRaiseApproval();

  if (loading) {
    return <div className="loading"><div className="spinner"></div> Loading...</div>;
  }

  return (
    <div>
      <div className="page-header">
        <h2>💵 Driver Raises (75¢/mile)</h2>
        <p>Ask dispatch teams which company drivers earned the higher rate this pay period.</p>
      </div>

      {status && (
        <div className={`alert alert-${status.type}`} style={{ marginBottom: 16 }}>{status.text}</div>
      )}

      <SettingsCard {...settings} />

      <TeamsCard
        teams={teams.teams}
        newTeamName={teams.newTeamName}
        setNewTeamName={teams.setNewTeamName}
        createTeam={teams.createTeam}
        toggleTeamActive={teams.toggleTeamActive}
        deleteTeam={teams.deleteTeam}
        openDriverManager={panel.openDriverManager}
        openMembersManager={panel.openMembersManager}
      />

      {panel.managingTeam && panel.panelMode === "drivers" && (
        <DriverAssignmentPanel {...panel} />
      )}

      {panel.managingTeam && panel.panelMode === "members" && (
        <TeamMembersPanel {...panel} />
      )}

      <SendReviewCard {...rounds} />

      <RoundsCard {...rounds} />
    </div>
  );
}
