/**
 * The failure classifier. Every case here is a failure the production panel
 * reported as the same sentence — "Could not load this page (a new version may
 * have been deployed)" — and each one needs a different answer from the admin
 * reading it.
 */
import { describe, expect, test } from "vitest";
import { ApiError } from "../api/apiError";
import { FAILURE_KIND, classifyFailure, failureKind } from "./pageFailure";

describe("a bug in the section's own code", () => {
  test("the reported ReferenceError is a code fault, not a stale deploy", () => {
    // The literal browser error from the incident.
    const error = new ReferenceError("getDaysUntilBirthday is not defined");
    const failure = classifyFailure(error, { where: "in DriverProfilesTable" });
    expect(failure.kind).toBe(FAILURE_KIND.CODE);
    expect(failure.title).toMatch(/bug/i);
    // The cause is shown, not replaced by a guess about deploys.
    expect(failure.technical).toContain("getDaysUntilBirthday is not defined");
    expect(failure.technical).toContain("in DriverProfilesTable");
    expect(failure.explanation).not.toMatch(/new version/i);
  });

  test("a TypeError from a bad render is also a code fault", () => {
    expect(failureKind(new TypeError("Cannot read properties of undefined (reading 'map')")))
      .toBe(FAILURE_KIND.CODE);
  });
});

describe("an outdated browser tab", () => {
  test("a failed dynamic import is the one case where reloading is the answer", () => {
    const error = new Error("Failed to fetch dynamically imported module: /admin/assets/GroupsPage-a1b2c3.js");
    const failure = classifyFailure(error);
    expect(failure.kind).toBe(FAILURE_KIND.STALE_BUNDLE);
    expect(failure.action).toBe("reload");
  });

  test("a ChunkLoadError by name counts too", () => {
    const error = new Error("Loading chunk 42 failed.");
    error.name = "ChunkLoadError";
    expect(failureKind(error)).toBe(FAILURE_KIND.STALE_BUNDLE);
  });

  test("an API path that answers with HTML means this tab wants a route the server lacks", () => {
    const error = new ApiError("HTTP Error: 404", { status: 404, htmlBody: true });
    expect(failureKind(error)).toBe(FAILURE_KIND.STALE_BUNDLE);
  });
});

describe("permission and session", () => {
  test("401 asks for a new sign-in", () => {
    const failure = classifyFailure(new ApiError("Invalid token", { status: 401 }));
    expect(failure.kind).toBe(FAILURE_KIND.AUTH);
    expect(failure.action).toBe("signin");
  });

  test("403 is a permission decision and offers no retry", () => {
    const failure = classifyFailure(new ApiError("Forbidden", { status: 403 }));
    expect(failure.kind).toBe(FAILURE_KIND.PERMISSION);
    expect(failure.action).toBe("none");
    expect(failure.actionLabel).toBeNull();
    expect(failure.explanation).toMatch(/permission/i);
  });
});

describe("the database and its limits", () => {
  test("a classified database outage says the data is intact, not empty", () => {
    const failure = classifyFailure(new ApiError("The database is not available", {
      status: 503, code: "DB_UNAVAILABLE",
    }));
    expect(failure.kind).toBe(FAILURE_KIND.DATABASE);
    expect(failure.explanation).toMatch(/NOT an empty list/);
    expect(failure.explanation).toMatch(/nothing has been lost/i);
  });

  test("a quota refusal is distinguished from an outage", () => {
    const failure = classifyFailure(new ApiError("Monthly data transfer quota exhausted", {
      status: 503, code: "DB_QUOTA",
    }));
    expect(failure.kind).toBe(FAILURE_KIND.QUOTA);
    expect(failure.explanation).toMatch(/limit/i);
    expect(failure.explanation).toMatch(/nothing was deleted/i);
  });

  test("rate limiting reuses the existing RATE_LIMITED code", () => {
    expect(failureKind(new ApiError("Too many attempts", { status: 429, code: "RATE_LIMITED" })))
      .toBe(FAILURE_KIND.QUOTA);
  });

  test("an unclassified 500 carrying a driver message is still recognized", () => {
    // The safety net for endpoints that only forward err.message.
    expect(failureKind(new ApiError("sorry, too many clients already", { status: 500 })))
      .toBe(FAILURE_KIND.DATABASE);
    expect(failureKind(new ApiError("Connection terminated unexpectedly", { status: 500 })))
      .toBe(FAILURE_KIND.DATABASE);
  });

  test("a plain 500 is a server fault, not a database claim", () => {
    expect(failureKind(new ApiError("Failed to build report", { status: 500 })))
      .toBe(FAILURE_KIND.SERVER);
  });
});

describe("network", () => {
  test("a rejected fetch is a connection problem", () => {
    const failure = classifyFailure(new TypeError("Failed to fetch"));
    expect(failure.kind).toBe(FAILURE_KIND.NETWORK);
    expect(failure.explanation).toMatch(/nothing was sent/i);
  });
});

describe("the fallback", () => {
  test("an unrecognized failure still shows its own message", () => {
    const failure = classifyFailure(new Error("something exotic"));
    expect(failure.kind).toBe(FAILURE_KIND.UNKNOWN);
    expect(failure.technical).toContain("something exotic");
  });

  test("no error at all does not crash the classifier", () => {
    const failure = classifyFailure(null);
    expect(failure.kind).toBe(FAILURE_KIND.UNKNOWN);
    expect(failure.technical).toBeTruthy();
  });

  test("every kind has wording and a defined action", () => {
    for (const kind of Object.values(FAILURE_KIND)) {
      const failure = classifyFailure({ name: "Probe", message: "m", __kind: kind });
      expect(failure.title).toBeTruthy();
      expect(failure.explanation).toBeTruthy();
      expect(["reload", "retry", "signin", "none"]).toContain(failure.action);
    }
  });
});
