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
      { key: "board", label: "Dispatcher Board" },
      { key: "ringcentral", label: "RingCentral & Bitrix24" },
      { key: "metacrm", label: "Facebook ↔ Bitrix" },
    ],
  },
  {
    label: "AI",
    sections: [{ key: "ai", label: "AI & Autonomy" }],
  },
  {
    label: "Telegram Bot",
    sections: [
      { key: "notifications", label: "Notifications" },
      { key: "groups", label: "Bonus Groups" },
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
