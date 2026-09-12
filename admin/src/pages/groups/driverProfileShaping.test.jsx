/**
 * Which tab a chat belongs on — the one place the question is asked.
 *
 * The precedence is the rule, and the tests are mostly about it: a chat that is
 * not a driver's is not an inactive driver, and a row nobody has finished
 * deciding about is not simply "active".
 */
import { describe, expect, test } from "vitest";
import { groupView, needsReview, boardHint, prepareDisplayProfiles } from "./driverProfileShaping";

const DRIVER = { group_id: 1, group_type: "driver", status: "active" };

describe("groupView", () => {
  test("an ordinary active driver is active", () => {
    expect(groupView(DRIVER)).toBe("active");
  });

  test("an inactive driver is inactive", () => {
    expect(groupView({ ...DRIVER, status: "inactive" })).toBe("inactive");
  });

  test("A CHAT THAT IS NOT A DRIVER'S IS COMPANY, whatever else is true of it", () => {
    // Five admin and feedback chats were typed as drivers with driver profiles
    // attached. Company wins over every other reason so they stop being read as
    // drivers who happen to be switched off.
    for (const over of [{}, { status: "inactive" }, { needs_review: true }]) {
      expect(groupView({ ...DRIVER, group_type: "company", ...over })).toBe("company");
    }
  });

  test("REVIEW OUTRANKS ACTIVE — 'we are not sure what this is' beats 'it is on'", () => {
    expect(groupView({ ...DRIVER, needs_review: true })).toBe("review");
    expect(groupView({ ...DRIVER, duplicate_review_required: true })).toBe("review");
    expect(groupView({ ...DRIVER, duplicate_conflict: true })).toBe("review");
    expect(groupView({ ...DRIVER, open_finding_keys: ["identity.unit_contested"] })).toBe("review");
  });

  test("an inactive chat with an open question is still review", () => {
    expect(groupView({ ...DRIVER, status: "inactive", needs_review: true })).toBe("review");
  });

  test("an empty finding list is not a review reason", () => {
    expect(groupView({ ...DRIVER, open_finding_keys: [] })).toBe("active");
  });

  test("NO CLIENT-SIDE GUESS FROM THE TITLE", () => {
    // An earlier page decided "company" by looking for the word in the chat
    // name, which disagreed with the server the moment a title was edited.
    expect(groupView({ ...DRIVER, group_name: "WENZE COMPANY DRIVERS TEAM" })).toBe("active");
    expect(groupView({ ...DRIVER, group_name: "Employee Feedback (Admin)" })).toBe("active");
  });

  test("a missing row is not a crash", () => {
    expect(groupView(null)).toBe("inactive");
    expect(groupView(undefined)).toBe("inactive");
  });

  test("a row with no group_type is treated as a driver, as the old page did", () => {
    expect(groupView({ group_id: 2, status: "active" })).toBe("active");
  });
});

describe("needsReview", () => {
  test("every reason, and nothing else", () => {
    expect(needsReview(DRIVER)).toBe(false);
    expect(needsReview({ ...DRIVER, needs_review: true })).toBe(true);
    expect(needsReview({ ...DRIVER, open_finding_keys: ["board.person_unmatched"] })).toBe(true);
    expect(needsReview(null)).toBe(false);
  });
});

describe("boardHint", () => {
  test("says what the board says", () => {
    expect(boardHint({ board: { present: true, status: "HOME", truck: "001" } }))
      .toBe("Board: HOME · truck 001");
  });

  test("a vanished row says so, because that is what somebody wants to see", () => {
    expect(boardHint({ board: { present: false, status: "HOME" } }))
      .toMatch(/No longer on the dispatcher board/);
  });

  test("A BOARD THAT IS SWITCHED OFF RENDERS NOTHING", () => {
    // Not an empty badge beside every driver in the fleet.
    expect(boardHint({ board: null })).toBeNull();
    expect(boardHint({})).toBeNull();
    expect(boardHint({ board: { present: true, status: null } })).toBeNull();
  });
});

describe("prepareDisplayProfiles", () => {
  const rows = [
    { group_id: 1, group_type: "driver", status: "active", date_of_birth: null },
    { group_id: 2, group_type: "driver", status: "inactive", date_of_birth: null },
    { group_id: 3, group_type: "company", status: "active", date_of_birth: null },
    { group_id: 4, group_type: "driver", status: "active", needs_review: true, date_of_birth: null },
  ];

  test("every tab filters by the same classifier", () => {
    const idsOn = (tab) => prepareDisplayProfiles(rows, tab, null).map((r) => r.group_id);
    expect(idsOn("active")).toEqual([1]);
    expect(idsOn("inactive")).toEqual([2]);
    expect(idsOn("company")).toEqual([3]);
    expect(idsOn("review")).toEqual([4]);
    expect(idsOn("all").sort()).toEqual([1, 2, 3, 4]);
  });

  test("EVERY ROW LANDS ON EXACTLY ONE TAB", () => {
    const seen = ["active", "inactive", "company", "review"]
      .flatMap((tab) => prepareDisplayProfiles(rows, tab, null).map((r) => r.group_id));
    expect(seen.sort()).toEqual([1, 2, 3, 4]);
    expect(new Set(seen).size).toBe(seen.length);
  });
});
