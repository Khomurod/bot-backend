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
  // 223 with Admin Accounts and Change password (October 2026):
  // `getAdminUsers`, `getAdminRoles`, `createAdminUser`, `updateAdminUser`,
  // `changePassword`.
  // 218 after the October 2026 hidden-functions audit, from a real 236: the
  // eleven AI Reports / Insights calls, the six old driver-group calls
  // (`getGroups`, `aiParseDriverProfiles`, `setGroupLanguage`,
  // `setGroupBirthday`, `setGroupStatus`, `runGroupStatusAi`),
  // `getDriverGroups`, `getOperationsCorrection` and
  // `getRecruitingKnowledgeHistory` went — twenty, none with a caller — and
  // `getGroupMembers` (the Driver Username picker had been calling a function
  // that did not exist) and `setAiPolicySourceEnabled` came. The floor had
  // been left at 215 while the surface grew to 236; it is the real size again.
  // 215 with Settings -> AI's lessons (October 2026): `getAiLessons`,
  // `removeAiLesson` and `skipAiLearningQuestion`.
  // 212 after the Finance Monitor (October 2026): Settings -> Finance's four
  // calls (`getFinanceSettings`, `getFinanceStatus`, `validateFinanceChat`,
  // `updateFinanceSettings`) and the Finance page's nine (the message, money
  // code, event, document and report lists, re-read, retry, preview and
  // send-now) went with it — exactly thirteen, from 225.
  // 225 after the dispatcher ETA feature (October 2026): its four ETA-schedule
  // calls (`getDispatchTestingGroups`, `saveDispatchEtaGlobalIntervals`,
  // `updateDispatchTestingGroup`, `updateAllDispatchTestingGroups`) went with
  // it, from 229 — the floor had been left at 189 while the surface grew, and
  // is raised to the real size here so the next drop is noticed.
  // 189 after the Dispatch Center: `parseDispatchRateCon`,
  // `sendDispatchToTelegram` and `getDispatchTestingGroupDetails` went with the
  // Send Load tab and its diagnostics expander — exactly three, and the floor
  // moved by exactly three. It was 192 after the Trailer Department, Trailer
  // Tracking and QBQ/SOS, and 205 when api.js was first split into domain
  // modules. Growing this is fine — update the number. A DROP that is not a
  // deliberate feature removal means a call site somewhere just broke.
  expect(Object.keys(api).length).toBeGreaterThanOrEqual(223);
});

describe("a sample of calls from every domain still resolves", () => {
  // One per module: proves the forward chain works end to end, not just that
  // some names exist.
  const samples = [
    "login", "getGroupsManage", "getQuestions", "sendBroadcast", "uploadMedia",
    // No dispatch sample: the Send Load functions went with the Dispatch
    // Center, and the four ETA-schedule calls with the ETA feature (Oct 2026).
    "getScheduledMessages", "getLeads", "editTelegramMessage",
    "getEmployeeBirthdays", "getFacebookLeadPages", "getMileageBonusOverview",
    "getHomeTimeOverview", "getGroupAccess",
    "getBotUsers", "getRecruiters",
    "getLiveLocationsConfig", "getSafetyEventSettings",
  ];
  test.each(samples)("api.%s is a function", (name) => {
    expect(typeof api[name]).toBe("function");
  });
});
