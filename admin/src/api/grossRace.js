import { API_BASE } from "./http";

/**
 * The Gross Grand Prix standings for one display: "teams" or "dispatchers".
 * Public, like the recruiters' leaderboard: no auth header. The server reads
 * Datatruck itself, so the page never holds a Datatruck token.
 */
export async function getGrossRace(view) {
  const res = await fetch(`${API_BASE}/gross-race?view=${encodeURIComponent(view)}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
