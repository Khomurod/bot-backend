import { getDaysUntilBirthday, sortBySoonestBirthday } from "../../components/Shared";

/**
 * Shaping and validating one driver profile for the Driver Groups screen —
 * pure functions, no I/O and no React.
 *
 * Driver Groups is the SOURCE OF TRUTH for driver identity, so these rules are
 * read by Home Time and Bot Group Access downstream: what counts as active,
 * what a driver is called when the name fields are partly empty, and whether a
 * profile is a team-driver pair. Keeping them here makes each one testable
 * without a database or a browser.
 *
 * normalizeManualUsername / isValidManualUsername mirror what the server
 * accepts (3–32 chars of letters, digits, underscore, no '@'); a stricter or
 * looser copy here would either reject valid drivers or send junk the server
 * rejects after the optimistic UI has already reported success.
 *
 * Split out of admin/src/pages/GroupsPage.jsx.
 */
export function formatDateValue(value) {
  if (!value) return "";
  return String(value).split("T")[0];
}

export function isDriverActive(profile) {
  return profile.status !== "inactive";
}

export function formatStatusSource(source) {
  if (source === "manual") return "Manual";
  if (source === "ai") return "AI";
  if (source === "bot") return "Bot";
  return "—";
}

/**
 * Which tab a group belongs on. PURE, and the ONE place the question is asked.
 *
 * The order is the whole rule, and each step is ahead of the next for a reason:
 *
 *   company  `group_type !== 'driver'`. A chat that is not a driver's is not an
 *            inactive driver — it is a different KIND of thing, and showing it
 *            among the drivers is how five admin and feedback chats ended up
 *            typed as drivers with driver profiles attached.
 *   review   something about this row is unresolved: Wenze flagged it, a
 *            duplicate needs a decision, or a finding about its identity is
 *            open. Ahead of active/inactive because "we are not sure what this
 *            row IS" outranks "it is switched on".
 *   active   what `isDriverActive` has always meant.
 *
 * NO CLIENT-SIDE GUESS FROM A TITLE. An earlier Groups page decided "company"
 * by looking for the word in the chat name, which disagreed with the server the
 * moment a title was edited. `group_type` is a stored fact and the only input
 * here.
 */
export function groupView(row) {
  if (!row) return "inactive";
  if (row.group_type && row.group_type !== "driver") return "company";
  if (needsReview(row)) return "review";
  return isDriverActive(row) ? "active" : "inactive";
}

/** Everything that means "a person has not finished deciding about this row". */
export function needsReview(row) {
  if (!row) return false;
  if (row.needs_review === true) return true;
  if (row.duplicate_review_required === true) return true;
  if (row.duplicate_conflict === true) return true;
  return Array.isArray(row.open_finding_keys) && row.open_finding_keys.length > 0;
}

/**
 * What the dispatcher board says about this driver, in a few words.
 *
 * Returns null when the board has nothing to say — no row, or a row that is no
 * longer on it — so the caller renders nothing rather than an empty badge. A
 * board that is switched off must not put a grey box beside every driver.
 */
export function boardHint(row) {
  const board = row?.board;
  if (!board) return null;
  if (board.present === false) return "No longer on the dispatcher board";
  if (!board.status) return null;
  return `Board: ${board.status}${board.truck ? ` · truck ${board.truck}` : ""}`;
}

export function prepareDisplayProfiles(allProfiles, activeTab, statusSort) {
  let list = sortBySoonestBirthday(allProfiles, (p) => p.date_of_birth);

  // EVERY TAB EXCEPT `all` FILTERS BY THE SAME FUNCTION, so a row can never
  // appear on two tabs or on none — which is what a per-tab predicate drifts
  // into the moment one of them is edited.
  if (activeTab && activeTab !== "all") {
    list = list.filter((p) => groupView(p) === activeTab);
  } else if (statusSort) {
    list = [...list].sort((a, b) => {
      const aRank = isDriverActive(a) ? 0 : 1;
      const bRank = isDriverActive(b) ? 0 : 1;
      const statusCmp = statusSort === "active-first" ? aRank - bRank : bRank - aRank;
      if (statusCmp !== 0) return statusCmp;
      return getDaysUntilBirthday(a.date_of_birth) - getDaysUntilBirthday(b.date_of_birth);
    });
  }

  return list;
}

export function profileToDraft(profile) {
  return {
    first_name: profile.first_name || "",
    last_name: profile.last_name || "",
    secondary_first_name: profile.secondary_first_name || "",
    secondary_last_name: profile.secondary_last_name || "",
    driver_type: profile.driver_type || "owner",
    status: profile.status || "active",
    unit_number: profile.unit_number || "",
    language: profile.language || "en",
    date_of_birth: formatDateValue(profile.date_of_birth),
    date_of_start: formatDateValue(profile.date_of_start),
    needs_review: profile.needs_review === true,
    telegram_username: profile.telegram_username || "",
  };
}

// Client-side mirror of the server's Telegram username rule (letters, digits,
// underscore; a single optional leading '@'). The server is still the
// authority and normalizes/stores without the '@'.
export function normalizeManualUsername(value) {
  return String(value == null ? "" : value).trim().replace(/^@+/, "");
}
export function isValidManualUsername(value) {
  const cleaned = normalizeManualUsername(value);
  return /^[A-Za-z0-9_]{3,32}$/.test(cleaned);
}

export function shouldShowTeamInputs(profile, draft) {
  return Boolean(
    profile.secondary_first_name
    || profile.secondary_last_name
    || draft.secondary_first_name
    || draft.secondary_last_name
    || String(profile.group_name || "").includes("/")
  );
}

export function driverLabel(profile) {
  const primary = [profile.first_name, profile.last_name].filter(Boolean).join(" ").trim();
  const secondary = [profile.secondary_first_name, profile.secondary_last_name].filter(Boolean).join(" ").trim();
  if (primary && secondary) return `${primary} / ${secondary}`;
  return primary || secondary || profile.display_name || profile.full_name || "";
}

export function memberOptionLabel(member) {
  const name = member.display_name || `User ${member.telegram_user_id}`;
  return member.username ? `${name} (@${member.username})` : `${name} (no @username)`;
}
