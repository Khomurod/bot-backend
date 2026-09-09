/**
 * The translation layer between the engine and a person.
 *
 * These rules decide whether the page is readable. A finding whose proposed
 * change renders as `[object Object]`, or whose context fields are shown as
 * though they were edits, is a page an operator stops trusting — and the bug is
 * invisible in a screenshot because something is always rendered.
 */
import { describe, expect, test } from "vitest";

import {
  changeRows, changeContext, correctionRows, groupByCheck,
  initiatorLabel, confidenceLabel, checkLabel, formatAgo,
} from "./labels";

describe("the proposed change", () => {
  const proposal = {
    table: "driver_road_history",
    id: 7,
    returnToRoadAt: { from: null, to: "2026-08-31T00:00:00Z" },
    homeDays: { from: null, to: 6 },
  };

  test("only from/to pairs count as changes", () => {
    const rows = changeRows(proposal);
    expect(rows.map((r) => r.field)).toEqual(["returnToRoadAt", "homeDays"]);
    expect(rows[0].from).toBe("—");
    expect(rows[0].to).toBe("2026-08-31T00:00:00Z");
  });

  test("context is shown as context, not as a rewrite of the row", () => {
    expect(changeContext(proposal)).toEqual([
      { field: "table", value: "driver_road_history" },
      { field: "id", value: "7" },
    ]);
  });

  test("a finding with nothing proposed produces no rows", () => {
    expect(changeRows(null)).toEqual([]);
    expect(changeRows({ groupId: 5 })).toEqual([]);
  });

  test("a null 'to' is still a change, and reads as one", () => {
    const rows = changeRows({ linkedRequestId: { from: 12, to: null } });
    expect(rows).toEqual([{ field: "linkedRequestId", from: "12", to: "—" }]);
  });

  test("the FLAT shape counts too — identity checks write one named field", () => {
    // identity.status_disagreement writes { table, groupId, field, from, to },
    // not a nested pair. Reading only the nested form made this render as
    // "nothing is proposed" beside a live Apply button.
    const rows = changeRows({
      table: "driver_profiles", groupId: 49, field: "status", from: "inactive", to: "active",
    });
    expect(rows).toEqual([{ field: "status", from: "inactive", to: "active" }]);
  });

  test("the flat shape's own keys are not repeated as context", () => {
    const context = changeContext({
      table: "driver_profiles", groupId: 49, field: "status", from: "inactive", to: "active",
    });
    expect(context.map((c) => c.field)).toEqual(["table", "groupId"]);
  });

  test("a proposal with no change at all still yields nothing", () => {
    // home_time.ghost_home_status: { table, groupId, action: 'retire' }
    expect(changeRows({ table: "driver_home_status", groupId: 4, action: "retire" })).toEqual([]);
  });

  test("nothing ever renders as [object Object]", () => {
    const rows = changeRows({ payload: { from: { a: 1 }, to: [1, 2] } });
    expect(rows[0].from).toBe('{"a":1}');
    expect(rows[0].to).toBe("[1,2]");
  });
});

describe("what a correction actually changed", () => {
  test("takes the union of the before and after images", () => {
    const rows = correctionRows({
      oldValues: { return_to_road_at: null, home_days: null },
      newValues: { return_to_road_at: "2026-08-31T00:00:00Z", home_days: 6, linked_request_id: 4 },
    });
    expect(rows.map((r) => r.field)).toEqual(
      ["return_to_road_at", "home_days", "linked_request_id"]
    );
    expect(rows[2]).toEqual({ field: "linked_request_id", from: "—", to: "4" });
  });

  test("survives a correction with no images at all", () => {
    expect(correctionRows({})).toEqual([]);
    expect(correctionRows(null)).toEqual([]);
  });
});

describe("grouping", () => {
  const finding = (id, checkKey, severity) => ({ id, checkKey, severity });

  test("46 drivers past their allowance is one row, not 46", () => {
    const groups = groupByCheck([
      finding(1, "home_time.road_clock_past_allowance", "info"),
      finding(2, "home_time.road_clock_past_allowance", "info"),
      finding(3, "identity.duplicate_unit", "serious"),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0].checkKey).toBe("identity.duplicate_unit");
    expect(groups[1].items).toHaveLength(2);
  });

  test("a group is as loud as its loudest member", () => {
    const [group] = groupByCheck([
      finding(1, "identity.status_disagreement", "info"),
      finding(2, "identity.status_disagreement", "serious"),
    ]);
    expect(group.severity).toBe("serious");
  });

  test("severity outranks size", () => {
    const groups = groupByCheck([
      finding(1, "a", "info"), finding(2, "a", "info"), finding(3, "a", "info"),
      finding(4, "b", "warning"),
    ]);
    expect(groups[0].checkKey).toBe("b");
  });
});

describe("attribution", () => {
  test("'system' is spelled out so nobody reads it as a model", () => {
    expect(initiatorLabel("system")).toMatch(/recorded evidence/);
    expect(initiatorLabel("system")).not.toMatch(/AI|model/i);
  });

  test("an administrator is named by id", () => {
    expect(initiatorLabel("admin:4")).toBe("Administrator #4");
  });
});

describe("hedging", () => {
  test("confidence is words, not false precision", () => {
    expect(confidenceLabel(95)).toMatch(/Very high/);
    expect(confidenceLabel(90)).toMatch(/High/);
    expect(confidenceLabel(60)).toMatch(/Moderate/);
    expect(confidenceLabel(null)).toBeNull();
    expect(confidenceLabel("not a number")).toBeNull();
  });

  test("an unknown check key falls back to itself rather than to nothing", () => {
    expect(checkLabel("something.new")).toBe("something.new");
    expect(checkLabel("home_time.closable_open_cycle")).toBe("Home stay never closed");
  });

  test("a sweep that never ran says so", () => {
    expect(formatAgo(null)).toBe("never");
    expect(formatAgo("nonsense")).toBe("never");
    expect(formatAgo(new Date().toISOString())).toBe("just now");
  });
});
