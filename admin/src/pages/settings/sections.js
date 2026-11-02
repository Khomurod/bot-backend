/**
 * Settings, grouped by what a person came to change — pure data, no React.
 *
 * The keys are the addresses (`#settings/<key>`) and must never be renamed:
 * a bookmarked section, and every legacy page key in
 * navigation/pageKeys.js, points at one. Labels can change freely.
 * Why each section sits in its group: docs/redesign/structure.md.
 */
export const SETTINGS_GROUPS = Object.freeze([
  {
    label: "Integrations",
    sections: [
      { key: "location", label: "Location Providers" },
      { key: "samsara", label: "Samsara" },
      // Its own section since November 2026: it has its own Save.
      { key: "samsara_video", label: "Samsara Video & Music" },
      { key: "board", label: "Dispatcher Board" },
      // One "RingCentral & Bitrix24" screen of six cards until November 2026.
      // `ringcentral` stays the recruiters' address, which old links meant.
      { key: "ringcentral", label: "Recruiters & Numbers" },
      { key: "rc_connection", label: "RingCentral Connection" },
      { key: "bitrix", label: "Bitrix24" },
      { key: "metacrm", label: "Facebook ↔ Bitrix" },
    ],
  },
  {
    label: "AI",
    // One screen ("AI & Autonomy") until November 2026; split because it was
    // 6.6 screens of six unrelated jobs. `ai` stays the providers' address.
    sections: [
      { key: "ai", label: "AI Providers" },
      { key: "ai_tasks", label: "AI Tasks" },
      { key: "ai_questions", label: "Wenze's Questions" },
      { key: "ai_terms", label: "Provider Terms" },
    ],
  },
  {
    label: "Telegram Bot",
    sections: [
      // "Notifications" and "Bonus Groups" until November 2026: both are
      // "which group does this go to?". `#settings/groups` lands here.
      { key: "notifications", label: "Where the Bot Posts" },
      { key: "access", label: "Group Access" },
      { key: "reactions", label: "Auto Reactions" },
    ],
  },
  {
    label: "Recruiting",
    sections: [{ key: "safety", label: "Safety Approvals" }],
  },
  {
    label: "Office Screens",
    sections: [{ key: "grossrace", label: "Gross Grand Prix" }],
  },
  {
    label: "Administration",
    sections: [{ key: "admins", label: "Admin Accounts" }],
  },
  {
    label: "Maintenance",
    sections: [{ key: "leftovers", label: "Retired Leftovers" }],
  },
]);

/**
 * Section keys that no longer name a section of their own, and the section
 * their content is in now. A held link (`#settings/groups`) must open that
 * content, not the first section — and never be renamed away.
 */
export const SETTINGS_SECTION_ALIASES = Object.freeze({
  groups: "notifications",
});

/** Every section key, in display order — the first one opens by default. */
export const SETTINGS_SECTION_KEYS = Object.freeze(
  SETTINGS_GROUPS.flatMap((group) => group.sections.map((section) => section.key)),
);

/** The label of a section key, or null. */
export function settingsSectionLabel(key) {
  for (const group of SETTINGS_GROUPS) {
    const section = group.sections.find((s) => s.key === key);
    if (section) return section.label;
  }
  return null;
}
