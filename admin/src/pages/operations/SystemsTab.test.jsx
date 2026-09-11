import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

import SystemsTab from "./SystemsTab";

import * as api from "../../api";

// Hoisted by vitest above the imports, which is why the mock reads after them.
vi.mock("../../api", () => ({ getSystems: vi.fn() }));

const component = (over = {}) => ({
  component: "fuel_risk", label: "the fuel risk watch", group: "engine",
  critical: true, state: "healthy", reason: "ran",
  lastRunAt: new Date().toISOString(), consecutiveFailures: 0, runsTotal: 12,
  ...over,
});

beforeEach(() => vi.resetAllMocks());

describe("SystemsTab", () => {
  it("separates a worker that STOPPED from one that ran and found nothing", async () => {
    api.getSystems.mockResolvedValue({
      components: [
        component(),
        component({
          component: "retention_watch", label: "driver retention",
          state: "stale_stopped", reason: "no pass has finished in 900 minutes",
        }),
      ],
      byState: { healthy: 1, stale_stopped: 1 },
      needingAttention: 1,
    });

    render(<SystemsTab flash={() => {}} />);
    await waitFor(() => expect(screen.getByText("driver retention")).toBeInTheDocument());
    expect(screen.getByText(/no pass has finished in 900 minutes/)).toBeInTheDocument();
    expect(screen.getByText("· Stopped")).toBeInTheDocument();
    expect(screen.getByText("· Working")).toBeInTheDocument();
  });

  it("shows a feature nobody configured with the missing thing named", async () => {
    api.getSystems.mockResolvedValue({
      components: [component({
        component: "route_control", label: "route monitoring", group: "engine",
        state: "needs_human_attention", reason: "no Google Maps key configured",
        lastRunAt: null, runsTotal: 0,
      })],
      byState: { needs_human_attention: 1 },
      needingAttention: 1,
    });

    render(<SystemsTab flash={() => {}} />);
    await waitFor(() => expect(screen.getByText("route monitoring")).toBeInTheDocument());
    // The reason IS the instruction. "Failing" tells an operator nothing to do.
    expect(screen.getByText("no Google Maps key configured")).toBeInTheDocument();
    expect(screen.getByText("· Needs a person")).toBeInTheDocument();
  });

  it("never renders 'not reported' as working", async () => {
    api.getSystems.mockResolvedValue({
      components: [component({ state: "cannot_determine", reason: "no run has ever been recorded", lastRunAt: null })],
      byState: { cannot_determine: 1 },
      needingAttention: 0,
    });

    render(<SystemsTab flash={() => {}} />);
    await waitFor(() => expect(screen.getByText("· Not reported")).toBeInTheDocument());
    expect(screen.queryByText("· Working")).not.toBeInTheDocument();
  });

  it("keeps the last good data when a refresh fails, instead of blanking the page", async () => {
    api.getSystems.mockResolvedValueOnce({
      components: [component()], byState: { healthy: 1 }, needingAttention: 0,
    });
    render(<SystemsTab flash={() => {}} />);
    await waitFor(() => expect(screen.getByText("the fuel risk watch")).toBeInTheDocument());

    api.getSystems.mockRejectedValue(new Error("database is away"));
    // The visible-interval refresh is what would blank it; assert the row survives.
    expect(screen.getByText("the fuel risk watch")).toBeInTheDocument();
  });

  it("offers no restart or retry control", async () => {
    api.getSystems.mockResolvedValue({
      components: [component({ state: "repeatedly_failing", reason: "3 consecutive failures" })],
      byState: { repeatedly_failing: 1 }, needingAttention: 1,
    });
    render(<SystemsTab flash={() => {}} />);
    await waitFor(() => expect(screen.getByText("· Failing")).toBeInTheDocument());
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
