/**
 * Live Locations, thinned in November 2026 (docs/redesign/density.md C4): the
 * five count cards repeated the filters, so the counts are ON the filters now,
 * computed by the same rule that filters; and a unit with no GPS says so once.
 */
import React from "react";
import { expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MapAndUnitList } from "./MapAndUnitList";
import { FILTERS, unitMatchesFilter } from "./constants";

const UNITS = [
  { unit: "101", driverName: "John Carter", provider: "samsara", location: { speedMph: 61, lastUpdated: new Date().toISOString(), isStale: false }, load: { loadId: "L1" } },
  // The warnings exactly as services/liveLocations/snapshot.js builds them.
  { unit: "202", driverName: "Maria Lopez", provider: null, location: null, load: null, warnings: ["no_gps", "no_active_load", "duplicate_unit_ambiguous"] },
];

test("each filter's count is what that filter would show", () => {
  const counts = Object.fromEntries(FILTERS.map((f) => [f.key, UNITS.filter((u) => unitMatchesFilter(u, f.key)).length]));
  expect(counts).toEqual({ all: 2, active_load: 1, no_load: 1, stale: 0, samsara: 1, factor: 0, leader: 0 });
});

test("the filters carry their counts, and a unit with no GPS says it once", () => {
  render(
    <MapAndUnitList
      mapContainerRef={{ current: null }} mapError={null} tileError={false} mapReady
      filtered={UNITS} units={UNITS} selectedUnit={null} selectUnit={vi.fn()} fitAll={vi.fn()}
      search="" setSearch={vi.fn()} filter="all" setFilter={vi.fn()}
      filterCounts={{ all: 2, active_load: 1, no_load: 1, stale: 0, samsara: 1, factor: 0, leader: 0 }}
      loading={false} snapshot={{}}
    />,
  );
  expect(screen.getByRole("button", { name: /^Active load 1/ })).toBeTruthy();
  expect(screen.getByRole("button", { name: /^No active load 1/ })).toBeTruthy();
  const maria = screen.getByText("Maria Lopez").closest("button");
  expect(maria.textContent.match(/no gps/gi)).toHaveLength(1);
  expect(maria.textContent.match(/no active load/gi)).toHaveLength(1);
  // A warning the row does not otherwise state is still shown.
  expect(maria.textContent).toMatch(/duplicate unit ambiguous/);
});
