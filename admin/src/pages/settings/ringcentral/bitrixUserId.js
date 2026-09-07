/**
 * Read a Bitrix user id out of whatever an operator actually pasted.
 *
 * WHY THIS EXISTS. The setup runbook tells operators to copy the id from a
 * Bitrix profile URL — `/company/personal/user/17/` — so a pasted URL is the
 * expected input, not a slip. A leading "#" or surrounding whitespace are just
 * as common. Before this, the server's normalizer turned any of those into
 * `null`, and the save then SUCCEEDED while silently clearing the mapping — the
 * "it won't save" symptom, with a green toast on top of it.
 *
 * So this accepts a profile URL or a "#"-prefixed number, and REJECTS anything
 * that is not ultimately a positive integer rather than coercing it away.
 *
 * Pure and stringy — no React, no I/O — so it is unit-tested directly.
 *
 * Returns `{ value, cleared, ok }`:
 *   ok:true,  cleared:true   → the field was blank on purpose (clears mapping)
 *   ok:true,  cleared:false  → `value` is the extracted positive-integer id
 *   ok:false                 → not an id; `value` is the original text, unchanged
 */
export function cleanBitrixUserId(raw) {
  const text = String(raw ?? "").trim();
  if (text === "") return { value: "", cleared: true, ok: true };

  const fromUrl = text.match(/user\/(\d+)/i);
  const candidate = fromUrl ? fromUrl[1] : text.replace(/^#/, "").trim();

  if (/^\d+$/.test(candidate) && Number(candidate) > 0) {
    return { value: candidate, cleared: false, ok: true };
  }
  return { value: text, cleared: false, ok: false };
}
