/** Who reads a stored value — the words the page uses for a scope. */
export const SCOPE_LABELS = Object.freeze({
  both: "Both apps",
  bot: "Wenze",
  samsara: "Samsara service",
});

export const TARGET_OPTIONS = Object.freeze([
  { value: "bot", label: "Wenze (bot-backend)" },
  { value: "samsara", label: "Samsara service (samsara-integration)" },
]);

export function scopeLabel(scope) {
  return SCOPE_LABELS[scope] || scope;
}
