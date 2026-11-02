/**
 * Home Time, thinned in November 2026 (docs/redesign/density.md C2, C3).
 * Nothing it said is gone — it is folded:
 *   - the screenshot import is a closed section that opens while a read waits;
 *   - Efficiency shows four headline numbers, the rest in one line, and the
 *     definitions behind "How is this calculated?";
 *   - Settings & Alerts is two titled groups with one-line hints, the full
 *     text behind "More", and a pointer to the road-bonus group.
 */
import React from "react";
import { expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ScreenshotImportCard } from "./ScreenshotImportCard";
import CompanyEfficiencyCard from "./CompanyEfficiencyCard";
import HomeTimeSettingsCard from "../HomeTimeSettingsCard";

const importProps = {
  importFiles: [], setImportFiles: vi.fn(), setImportRows: vi.fn(),
  importing: false, applyingImport: false, readScreenshots: vi.fn(), applyImport: vi.fn(),
};

test("the screenshot import is closed until needed, and open while a read waits", () => {
  const { rerender } = render(<ScreenshotImportCard {...importProps} importRows={null} />);
  expect(screen.getByText("Import from screenshots").closest("details").open).toBe(false);
  rerender(<ScreenshotImportCard {...importProps} importRows={[]} />);
  expect(screen.getByText("Import from screenshots").closest("details").open).toBe(true);
});

test("Efficiency: four headline numbers, the rest in one line, definitions folded", () => {
  const company = {
    road_allowance_days: 42, home_allowance_days: 7, strict_efficiency_pct: 71, operational_efficiency_pct: 80,
    commitment_pct: 64, total_completed_cycles: 120, incomplete: 5, total_eligible_drivers: 30,
    approved_exception: 9, commitment_evaluated: 25, commitment_met: 16, commitment_broken: 9,
    commitment_incomplete: 3, commitment_none: 40, commitment_grace_days: 1,
  };
  const { container } = render(
    <CompanyEfficiencyCard company={company} range="90" setRange={vi.fn()} donutSegments={[]} />,
  );
  expect(container.querySelectorAll(".home-time-summary-chip")).toHaveLength(4);
  expect(screen.getByText("Commitments met")).toBeTruthy();
  expect(container.textContent).toMatch(/30 eligible drivers · 9 approved exceptions/);
  expect(container.textContent).toMatch(/16 met/);
  expect(container.textContent).toMatch(/40 with no approved dates/);
  const how = screen.getByText("How is this calculated?").closest("details");
  expect(how.open).toBe(false);
  expect(how.textContent).toMatch(/Strict efficiency = compliant cycles/);
});

test("Settings & Alerts: titled groups, one-line hints, the full text behind More", () => {
  const settings = {
    enabled: true, road_allowance_weeks: 6, home_allowance_days: 7, bonus_per_week: 100,
    completed_notify_group_id: "", internal_clarification_group_id: "", driver_clarification_enabled: true,
  };
  render(<HomeTimeSettingsCard settings={settings} saving={false} onSave={vi.fn()} />);
  expect(screen.getByRole("heading", { name: "Policy" })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Where notices go" })).toBeTruthy();
  expect(screen.getByText(/no Approve buttons/)).toBeTruthy();
  expect(screen.getAllByText(/Empty: /).length).toBeGreaterThanOrEqual(2);
  expect(screen.getByRole("link", { name: /Bonus groups/ })).toHaveAttribute("href", "#settings/groups");
  const more = screen.getAllByText("More").map((s) => s.closest("details"));
  expect(more.every((d) => d.open === false)).toBe(true);
  expect(more[0].textContent).toMatch(/tags the three managers/);
});
