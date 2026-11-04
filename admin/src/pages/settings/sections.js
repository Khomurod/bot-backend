/**
 * Settings, grouped by what a person came to change — pure data, no React.
 *
 * The keys are the addresses (`#settings/<key>`) and must never be renamed:
 * a bookmarked section, and every legacy page key in
 * navigation/pageKeys.js, points at one. Labels can change freely.
 * Why each section sits in its group: docs/redesign/structure.md.
 */
export const SETTINGS_GROUPS = Object.freeze([
  // FIVE GROUPS OF 3–5 SINCE NOVEMBER 2026 (docs/redesign/density.md A6). The
  // October list had seven groups, five of them with one entry; and once the
  // AI, RingCentral and Samsara screens were split, "Integrations" alone would
  // have held eight. Grouped by the work a section serves, not by whether it
  // happens to talk to an outside service.
  {
    label: "Fleet",
    sections: [
      { key: "location", label: "Location Providers" },
      { key: "samsara", label: "Samsara" },
      // Its own section since November 2026: it has its own Save.
      { key: "samsara_video", label: "Samsara Video & Music" },
      { key: "board", label: "Dispatcher Board" },
    ],
  },
  {
    label: "Recruiting",
    sections: [
      // One "RingCentral & Bitrix24" screen of six cards until November 2026.
      // `ringcentral` stays the recruiters' address, which old links meant.
      { key: "ringcentral", label: "Recruiters & Numbers" },
      { key: "rc_connection", label: "RingCentral Connection" },
      { key: "bitrix", label: "Bitrix24" },
      { key: "metacrm", label: "Facebook ↔ Bitrix" },
      { key: "safety", label: "Safety Approvals" },
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
    label: "Telegram",
    sections: [
      // "Notifications" and "Bonus Groups" until November 2026: both are
      // "which group does this go to?". `#settings/groups` lands here.
      { key: "notifications", label: "Where the Bot Posts" },
      { key: "access", label: "Group Access" },
      { key: "reactions", label: "Auto Reactions" },
    ],
  },
  {
    label: "System",
    sections: [
      { key: "admins", label: "Admin Accounts" },
      // November 2026: the deployment's settings, out of Coolify. Super admins only.
      { key: "secrets", label: "Secrets" },
      { key: "grossrace", label: "Gross Grand Prix" },
      // Last, so it is never where a person lands first.
      { key: "leftovers", label: "Retired Leftovers" },
    ],
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
