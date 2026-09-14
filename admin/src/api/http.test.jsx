/**
 * The one funnel every failed admin request comes through.
 *
 * WHAT THIS EXISTS TO STOP. `handleApiError` read the server's explanation from
 * `errData.error` and nothing else. The Finance settings routes answered with
 * `errData.message` — the only settings file that did — so a 400 that had gone
 * to the trouble of saying "this is a 'private' chat, not a group. Use a group,
 * supergroup or channel the bot belongs to." arrived at the admin, lost its
 * text here, and rendered as "HTTP Error: 400". Seen in production, on a screen
 * that failed on every blur of one field with no way to tell why.
 *
 * Those routes now use `error` like every other one. This file holds the other
 * half: the funnel accepts both words, so the next author who reaches for the
 * wrong one is not silently swallowed too.
 */
import { describe, expect, test } from "vitest";
import { handleApiError } from "./http";

/** `handleApiError` THROWS rather than returning; this is what it threw. */
async function thrownBy(response) {
  try {
    await handleApiError(response);
  } catch (err) {
    return err;
  }
  throw new Error("handleApiError resolved — it is supposed to throw");
}

/** The shape `fetch` hands back, with only what this function reads. */
function jsonResponse(status, body) {
  return {
    status,
    headers: { get: (k) => (k.toLowerCase() === "content-type" ? "application/json" : null) },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe("the server's explanation reaches the screen", () => {
  test("an `error`-shaped body is used verbatim — the house shape", async () => {
    const err = await thrownBy(jsonResponse(400, { error: "Validate the finance group first." }));
    expect(err.message).toBe("Validate the finance group first.");
    expect(err.status).toBe(400);
  });

  test("a `message`-shaped body is used too, rather than discarded", async () => {
    const err = await thrownBy(
      jsonResponse(400, { message: "this is a \"private\" chat, not a group." })
    );
    expect(err.message).toBe('this is a "private" chat, not a group.');
    expect(err.message).not.toMatch(/HTTP Error/);
  });

  test("`error` wins when a body carries both, so the house shape stays authoritative", async () => {
    const err = await thrownBy(jsonResponse(400, { error: "the real one", message: "the other one" }));
    expect(err.message).toBe("the real one");
  });

  test("a body with neither still falls back to the status line", async () => {
    const err = await thrownBy(jsonResponse(500, { unrelated: true }));
    expect(err.message).toBe("HTTP Error: 500");
  });

  test("the field and suggestion a server offers are carried, not dropped", async () => {
    const err = await thrownBy(jsonResponse(400, {
      error: "does not match any known chat, but -100777 is \"Wenze Finance\".",
      field: "weeklyReportChatId",
      suggestion: "-100777",
    }));
    expect(err.field).toBe("weeklyReportChatId");
    expect(err.suggestion).toBe("-100777");
  });
});
