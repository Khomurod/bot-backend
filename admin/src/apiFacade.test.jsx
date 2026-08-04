/**
 * admin/src/api.js is a compatibility façade over admin/src/api/<domain>.js.
 *
 * Roughly 200 call sites do `import * as api from "./api"`, so the façade's
 * export surface IS the contract. A domain module that stops being forwarded —
 * or two modules that collide on a name, which ESM resolves by silently
 * exporting neither — would turn into `api.something is not a function` at
 * runtime, in whichever screen happened to use it.
 *
 * These tests make that a build-time failure instead.
 */
import { describe, expect, test } from "vitest";
import * as api from "./api";
import facadeSource from "./api.js?raw";

/** The domain modules the façade forwards, in declaration order. */
const forwarded = [...facadeSource.matchAll(/export \* from '\.\/api\/([A-Za-z0-9]+)';/g)]
  .map((m) => m[1]);

const modules = import.meta.glob("./api/*.js", { eager: true });
const moduleFor = (name) => modules[`./api/${name}.js`];

test("the façade forwards a domain module for every feature area", () => {
  expect(forwarded.length).toBeGreaterThan(20);
  // No duplicates: a repeated forward hides a copy-paste mistake.
  expect(new Set(forwarded).size).toBe(forwarded.length);
  for (const name of forwarded) {
    expect(moduleFor(name), `./api/${name}.js must exist`).toBeDefined();
  }
});

test("every export of every forwarded module is reachable through the façade", () => {
  const missing = [];
  for (const name of forwarded) {
    for (const exported of Object.keys(moduleFor(name))) {
      if (!(exported in api)) missing.push(`${name}.${exported}`);
    }
  }
  expect(missing).toEqual([]);
});

test("no two forwarded modules export the same name", () => {
  // ESM makes an ambiguous `export *` name simply absent — no error, no warning.
  const seen = new Map();
  const clashes = [];
  for (const name of forwarded) {
    for (const exported of Object.keys(moduleFor(name))) {
      if (seen.has(exported)) clashes.push(`${exported}: ${seen.get(exported)} and ${name}`);
      seen.set(exported, name);
    }
  }
  expect(clashes).toEqual([]);
});

test("the public surface stays at its known size", () => {
  // 205 calls at the time api.js was split into domain modules. Growing this is
  // fine — update the number. A DROP means a call site somewhere just broke.
  expect(Object.keys(api).length).toBeGreaterThanOrEqual(205);
});

describe("a sample of calls from every domain still resolves", () => {
  // One per module: proves the forward chain works end to end, not just that
  // some names exist.
  const samples = [
    "login", "getGroups", "getQuestions", "sendBroadcast", "uploadMedia",
    "parseDispatchRateCon", "getScheduledMessages", "getLeads", "getAiReports",
    "getEmployeeBirthdays", "getFacebookLeadPages", "getMileageBonusOverview",
    "getRaiseSettings", "getHomeTimeOverview", "getGroupAccess", "getFuelMonitor",
    "getBotUsers", "getGmapsSettings", "getRouteAssignments", "getRecruiters",
    "getLiveLocationsConfig", "getSafetyEventSettings", "getTrailers",
  ];
  test.each(samples)("api.%s is a function", (name) => {
    expect(typeof api[name]).toBe("function");
  });
});
