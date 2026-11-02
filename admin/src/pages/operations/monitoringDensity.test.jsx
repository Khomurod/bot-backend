/**
 * Monitoring, thinned in November 2026 (docs/redesign/density.md B1, B2):
 *
 *   - System Health puts every row that needs a look first, whatever its
 *     group; each group below is one line that opens, and "not reported" is
 *     counted on its own, never as working.
 *   - "Wenze cannot tell anybody what it finds" heads only the notification
 *     destination; a missing RingCentral login is "not set up yet".
 *   - Automation shows the dry run before the switches, and keeps the
 *     internal keys under Details.
 */
import React from "react";
import { beforeEach, expect, test, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import * as api from "../../api";
import SystemsTab from "./SystemsTab";
import ConfigurationBanner from "./ConfigurationBanner";
import ChecksTab from "./ChecksTab";

vi.mock("../../api", () => ({ getSystems: vi.fn() }));

const row = (over) => ({
  component: "x", label: "x", group: "engine", critical: true, state: "healthy", reason: "ran",
  lastRunAt: new Date().toISOString(), consecutiveFailures: 0, runsTotal: 3, ...over,
});

const DELIVERY = row({
  component: "notification_destination", label: "Telegram notifications", group: "integration",
  state: "needs_human_attention", reason: "no Telegram group is configured, so every alert is discarded",
});
const RC = row({
  component: "ringcentral", label: "RingCentral", group: "integration",
  state: "needs_human_attention", reason: "no recruiter has signed in",
});

beforeEach(() => vi.resetAllMocks());

test("System Health: a stopped routine job is first, not below every working row", async () => {
  api.getSystems.mockResolvedValue({
    components: [
      row({ component: "a", label: "Load watch" }),
      row({ component: "b", label: "Birthday cards", group: "routine", state: "stale_stopped", reason: "no pass in 900 minutes" }),
      row({ component: "c", label: "Retention watch", state: "cannot_determine", reason: "first pass not due yet" }),
    ],
    byState: {}, needingAttention: 1,
  });
  render(<SystemsTab flash={() => {}} />);
  const section = await screen.findByRole("region", { name: "Needs a look" });
  expect(within(section).getByText("Birthday cards")).toBeTruthy();
  expect(within(section).queryByText("Load watch")).toBeNull();

  const engines = screen.getByText("Operational engines").closest("details");
  expect(engines.open).toBe(false);
  expect(engines.textContent).toMatch(/1 working, 1 not reported/);
  // The stopped job is not counted again inside its group.
  expect(screen.queryByText("Routine work")).toBeNull();
});

test("System Health: the lost-alerts row is said once, as the loudest line", async () => {
  api.getSystems.mockResolvedValue({ components: [DELIVERY, RC], byState: {}, needingAttention: 2 });
  render(<SystemsTab flash={() => {}} />);
  expect(await screen.findByText("Wenze cannot tell anybody what it finds.")).toBeTruthy();
  expect(screen.getAllByText(/every alert is discarded/)).toHaveLength(1);
  expect(screen.getByText("RingCentral")).toBeTruthy();
});

test("The banner keeps its alarm for the lost alerts, and calls the rest not set up", async () => {
  api.getSystems.mockResolvedValue({ components: [DELIVERY, RC] });
  render(<ConfigurationBanner />);
  expect(await screen.findByText("Wenze cannot tell anybody what it finds.")).toBeTruthy();
  expect(screen.getByText(/Not set up yet — this needs a person/)).toBeTruthy();
});

test("Without the lost alerts, the banner does not claim them", async () => {
  api.getSystems.mockResolvedValue({ components: [RC] });
  render(<ConfigurationBanner />);
  expect(await screen.findByText(/Not set up yet/)).toBeTruthy();
  expect(screen.queryByText(/cannot tell anybody/)).toBeNull();
});

test("Compact, the banner is one line that points at the findings tab", async () => {
  api.getSystems.mockResolvedValue({ components: [DELIVERY, RC] });
  render(<ConfigurationBanner compact />);
  const link = await screen.findByRole("link", { name: /details on the Needs attention tab/ });
  expect(link).toHaveAttribute("href", "#operations/findings");
  expect(screen.queryByText(/no recruiter has signed in/)).toBeNull();
});

test("Automation: the dry run comes before the switches; the keys are under Details", () => {
  render(
    <ChecksTab
      checks={[{ checkKey: "identity.duplicate_unit", actionKey: "merge", autoApplyEnabled: false, maxAutoPerRun: 25, updatedBy: "migration 0077" }]}
      busy={false}
      setCheckEnabled={vi.fn()}
      preview={null}
      loadPreview={vi.fn()}
    />,
  );
  const dry = screen.getByText("Dry run");
  const list = screen.getByText("What the system may correct by itself");
  expect(dry.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  const details = screen.getByText("Details").closest("details");
  expect(details.open).toBe(false);
  expect(details.textContent).toMatch(/identity\.duplicate_unit/);
  expect(screen.getByRole("checkbox", { name: "Auto-apply" })).toBeTruthy();
});
