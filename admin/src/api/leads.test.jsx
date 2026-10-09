/**
 * The Leads page's 45-second poll, client side.
 *
 * The server answers 304, with no body and without reading the list, when the
 * request names the ETag of the list it would send. So `getLeads` keeps the
 * last list and its ETag per source, asks with If-None-Match, and answers a
 * 304 from what it kept: about 300 bytes a poll instead of ~28 KB.
 *
 * What the page must not notice: `getLeads` still resolves to the list, and
 * to a NEW array every time. The page re-renders on every poll exactly as it
 * did when every poll was a 200, so its "5m ago" column keeps moving.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const ALL = [
  { id: 2, source: "indeed", full_name: "Dee Example", email: null, phone: "+15550100002",
    job_title: "CDL-A Driver", message: null, bitrix_status: "created", created_at: "2026-10-09T12:00:00.000Z" },
  { id: 1, source: "facebook", full_name: "Sam Example", email: "sam@example.test", phone: null,
    job_title: null, message: "Call after five", bitrix_status: "pending", created_at: "2026-10-08T09:00:00.000Z" },
];
const FACEBOOK = [ALL[1]];

function reply(status, body, etag) {
  const headers = new Headers();
  if (etag) headers.set("ETag", etag);
  if (body !== undefined) headers.set("Content-Type", "application/json");
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers });
}

let fetchMock;
const urlOf = (call) => fetchMock.mock.calls[call][0];
const headersOf = (call) => fetchMock.mock.calls[call][1].headers;

/** A fresh copy of the module each test, so nothing is remembered from the last one. */
async function loadGetLeads(...replies) {
  fetchMock = vi.fn();
  for (const r of replies) fetchMock.mockResolvedValueOnce(r);
  vi.stubGlobal("fetch", fetchMock);
  vi.resetModules();
  return (await import("./leads")).getLeads;
}

beforeEach(() => localStorage.setItem("token", "test-token"));
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("getLeads", () => {
  test("200, then a 304 answered from memory, then a source of its own", async () => {
    const getLeads = await loadGetLeads(
      reply(200, ALL, '"aaa"'),
      reply(304, undefined, '"aaa"'),
      reply(200, FACEBOOK, '"fff"'),
      reply(304, undefined, '"aaa"'),
    );

    const first = await getLeads("");
    expect(first).toEqual(ALL);
    expect(headersOf(0)["If-None-Match"]).toBeUndefined();

    const second = await getLeads("");
    expect(headersOf(1)["If-None-Match"]).toBe('"aaa"');
    expect(headersOf(1).Authorization).toBe("Bearer test-token");
    expect(second).toEqual(ALL);
    expect(second).not.toBe(first);

    const facebook = await getLeads("facebook");
    expect(urlOf(2)).toContain("source=facebook");
    expect(headersOf(2)["If-None-Match"]).toBeUndefined();
    expect(facebook).toEqual(FACEBOOK);

    const back = await getLeads("");
    expect(headersOf(3)["If-None-Match"]).toBe('"aaa"');
    expect(back).toEqual(ALL);

    // The cache-buster stays, so the browser's own cache never answers.
    for (let call = 0; call < 4; call += 1) expect(urlOf(call)).toMatch(/[?&]t=\d+/);
  });

  test("a 200 replaces what is remembered", async () => {
    const getLeads = await loadGetLeads(
      reply(200, FACEBOOK, '"old"'),
      reply(200, ALL, '"new"'),
      reply(304, undefined, '"new"'),
    );

    await getLeads("");
    expect(await getLeads("")).toEqual(ALL);
    expect(headersOf(1)["If-None-Match"]).toBe('"old"');
    expect(await getLeads("")).toEqual(ALL);
    expect(headersOf(2)["If-None-Match"]).toBe('"new"');
  });

  test("what a caller does to its list never reaches the remembered one", async () => {
    const getLeads = await loadGetLeads(reply(200, ALL, '"aaa"'), reply(304, undefined, '"aaa"'));

    const first = await getLeads("");
    first[0].full_name = "edited";
    first.pop();

    expect(await getLeads("")).toEqual(ALL);
  });

  test("a 304 with nothing remembered asks again, without If-None-Match", async () => {
    const getLeads = await loadGetLeads(reply(304), reply(200, FACEBOOK, '"fff"'));

    expect(await getLeads("facebook")).toEqual(FACEBOOK);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(headersOf(0)["If-None-Match"]).toBeUndefined();
    expect(headersOf(1)["If-None-Match"]).toBeUndefined();
  });

  test("an error is thrown as before, and what was remembered survives it", async () => {
    const getLeads = await loadGetLeads(
      reply(200, ALL, '"aaa"'),
      reply(500, { error: "Failed to fetch leads" }),
      reply(304, undefined, '"aaa"'),
    );

    await getLeads("");
    await expect(getLeads("")).rejects.toMatchObject({ message: "Failed to fetch leads", status: 500 });
    expect(await getLeads("")).toEqual(ALL);
    expect(headersOf(2)["If-None-Match"]).toBe('"aaa"');
  });
});
