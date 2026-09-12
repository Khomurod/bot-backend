/**
 * The database-transfer warning banner.
 *
 * It exists because this deployment reached 4.222 GB of a 5 GB monthly
 * allowance with nothing in the app aware of it. So the behaviour under test is
 * about restraint and honesty: silent below 80%, louder as it climbs, explicit
 * that the number is an estimate rather than a bill, and never an error of its
 * own when diagnostics are unavailable — a banner that breaks a page it was
 * meant to protect would be worse than no banner.
 */
import React from "react";
import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as api from "../api";
import DatabaseUsageBanner from "./DatabaseUsageBanner";

const usage = (overrides) => ({
  monthKey: "2026-09",
  estimated: true,
  bytes: 4.5 * 1024 ** 3,
  gigabytes: 4.5,
  budgetBytes: 5 * 1024 ** 3,
  budgetGigabytes: 5,
  percent: 90,
  level: "high",
  queries: 12345,
  rows: 98765,
  thresholds: [0.8, 0.9, 0.95],
  ...overrides,
});

let spy;

beforeEach(() => {
  spy = vi.spyOn(api, "getDatabaseUsage");
});

afterEach(() => {
  spy.mockRestore();
});

describe("below the first threshold", () => {
  test("shows nothing at all", async () => {
    spy.mockResolvedValue(usage({ percent: 42, level: "ok", gigabytes: 2.1 }));
    const { container } = render(<DatabaseUsageBanner />);
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});

describe("at 80% and above", () => {
  test("names the level, the usage and the month", async () => {
    spy.mockResolvedValue(usage({ percent: 82, level: "warning", gigabytes: 4.1 }));
    render(<DatabaseUsageBanner />);
    const banner = await screen.findByRole("status");
    expect(banner).toHaveTextContent(/82%/);
    expect(banner).toHaveTextContent(/4.1 GB of 5 GB/);
    expect(banner).toHaveTextContent(/2026-09/);
  });

  test("says the figure is an estimate, not the provider's bill", async () => {
    spy.mockResolvedValue(usage());
    render(<DatabaseUsageBanner />);
    const banner = await screen.findByRole("status");
    expect(banner).toHaveTextContent(/estimate/i);
    expect(banner).toHaveTextContent(/provider's dashboard/i);
  });

  test("escalates its wording as the percentage climbs", async () => {
    spy.mockResolvedValue(usage({ percent: 96, level: "critical", gigabytes: 4.8 }));
    render(<DatabaseUsageBanner />);
    expect(await screen.findByText(/Critical/)).toBeInTheDocument();
  });

  test("dismissal holds for that level, and it speaks up again when it worsens", async () => {
    spy.mockResolvedValue(usage({ percent: 82, level: "warning" }));
    render(<DatabaseUsageBanner />);
    await screen.findByRole("status");

    await userEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(screen.queryByRole("status")).toBeNull();

    // Returning to the tab refreshes (useVisibleInterval fires on visibility),
    // and this time usage is worse. A dismissal must not silence a WORSE
    // situation — that is how a warning ends up never being seen again.
    spy.mockResolvedValue(usage({ percent: 96, level: "critical" }));
    document.dispatchEvent(new Event("visibilitychange"));

    const banner = await screen.findByRole("status");
    expect(banner).toHaveTextContent(/96%/);
    expect(banner).toHaveTextContent(/Critical/);
  });

  test("a dismissed level stays dismissed across a refresh at the same level", async () => {
    spy.mockResolvedValue(usage({ percent: 82, level: "warning" }));
    render(<DatabaseUsageBanner />);
    await screen.findByRole("status");
    await userEvent.click(screen.getByRole("button", { name: /dismiss/i }));

    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("when diagnostics are unavailable", () => {
  test("stays silent instead of failing the page around it", async () => {
    spy.mockRejectedValue(new Error("HTTP Error: 503"));
    const { container } = render(<DatabaseUsageBanner />);
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});

describe("when the answer is not the shape this renders", () => {
  /**
   * A failed fetch was always handled; a malformed ANSWER was not. This is the
   * ONE component App renders outside PageErrorBoundary, so a throw here is
   * caught by nothing and React unmounts the entire admin panel — a blank page,
   * from the warning banner. Found by an App-level test whose api stub answered
   * `[]`: the panel rendered, then vanished.
   */
  /**
   * THE ASSERTION IS THE SIBLING, NOT AN EMPTY CONTAINER.
   *
   * "Renders nothing" is satisfied two ways: the banner declining to render, and
   * the banner throwing so React tears the tree down and leaves nothing behind.
   * A test asserting an empty container passes in BOTH cases — it did, against
   * the unguarded component, which is how nearly went in as proof of a fix it
   * could not see. So the page around it is rendered too, and the page is what
   * is asserted: it survives only if the banner did not throw. That is also the
   * actual production consequence, since nothing catches this one.
   */
  for (const [what, answer] of [
    ["an array where an object was expected", []],
    ["a 200 carrying someone else's error body", { error: "Bad Gateway" }],
    ["a level with none of the numbers", { level: "critical" }],
    ["a body missing only `queries`", {
      level: "warning", percent: 82, gigabytes: 4.1,
      budgetGigabytes: 5, monthKey: "2026-09",
    }],
    ["null", null],
    ["a string", "critical"],
  ]) {
    test(`${what}: the banner stays quiet and the panel stays up`, async () => {
      spy.mockResolvedValue(answer);
      render(
        <div>
          <DatabaseUsageBanner />
          <p>the admin panel</p>
        </div>,
      );
      await waitFor(() => expect(spy).toHaveBeenCalled());
      // Still there — so nothing threw past a boundary that does not exist.
      expect(screen.getByText("the admin panel")).toBeTruthy();
      expect(screen.queryByRole("status")).toBeNull();
    });
  }

  test("a field it does not use cannot make it vanish", async () => {
    // The guard is a whitelist of what is RENDERED, not a schema of what is
    // sent, so the server can add a field without the banner going quiet.
    spy.mockResolvedValue(usage({ percent: 91, level: "high", somethingNew: { deep: 1 } }));
    render(<DatabaseUsageBanner />);
    expect(await screen.findByRole("status")).toBeTruthy();
  });
});
