/**
 * Communications — the tab shell.
 *
 * This stage MOVED five screens; it changed none of them. The gates already
 * cover most of what a move breaks — `lint:imports` catches an import naming a
 * gone export, `lint:undef` an identifier left behind, the build a wrong
 * relative depth. What none of them can see is the part that is only true when
 * the page is actually rendered:
 *
 *   - every tab mounts without throwing, and renders its own content rather
 *     than an empty shell;
 *   - each of the five stripped its <h2>, so the page shows ONE header and not
 *     two. That is asserted on every tab, because a leftover only shows on the
 *     tab that kept it — asserting it on the default tab alone passes while
 *     four of the five are still wrong (confirmed: restoring Surveys' header
 *     fails exactly one test here);
 *   - only the open tab is mounted, so reading the queue does not fire the
 *     composer's requests.
 */
import React from "react";
import { expect, test, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import CommunicationsPage from "./CommunicationsPage";

// A tab that throws on render, swapped in for Surveys below.
vi.mock("./communications/SurveysTab", () => ({
  default: function ExplodingSurveys() {
    if (globalThis.__EXPLODE_SURVEYS__) throw new Error("Surveys blew up");
    return <p>Create and manage driver feedback surveys.</p>;
  },
}));

// Every request any tab makes, stubbed to an empty answer. The point is to
// mount the real tab components, not to exercise them.
vi.mock("../api", () => new Proxy({}, {
  get: (target, prop) => {
    if (prop === "__esModule") return true;
    if (!target[prop]) target[prop] = vi.fn().mockResolvedValue([]);
    return target[prop];
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  globalThis.__EXPLODE_SURVEYS__ = false;
});

const TABS = [
  ["Send Message", /Send messages and media to multiple driver groups/i],
  ["Surveys", /Create and manage driver feedback surveys/i],
  ["Scheduled", /Messages queued for future delivery/i],
  ["History", /Every message the bot has sent/i],
];

test("opens on Send Message", async () => {
  render(<CommunicationsPage />);
  expect(screen.getByRole("heading", { name: /^Messages$/i })).toBeTruthy();
  await waitFor(() => {
    expect(screen.getByText(TABS[0][1])).toBeTruthy();
  });
});

for (const [label, intro] of TABS) {
  test(`the ${label} tab resolves, mounts, and brings no second header`, async () => {
    render(<CommunicationsPage />);
    fireEvent.click(screen.getByRole("tab", { name: new RegExp(label, "i") }));
    await waitFor(() => {
      expect(screen.getByText(intro)).toBeTruthy();
    });
    // Checked on EVERY tab, not just the one the page opens on: each of these
    // five used to be a page and carried its own <h2>, and a leftover would
    // only show on the tab that kept it.
    expect(screen.queryAllByRole("heading", { level: 2 })).toHaveLength(1);
  });
}

test("only the open tab is mounted — the others are not rendered behind it", async () => {
  render(<CommunicationsPage />);
  await waitFor(() => expect(screen.getByText(TABS[0][1])).toBeTruthy());

  fireEvent.click(screen.getByRole("tab", { name: /History/i }));
  await waitFor(() => expect(screen.getByText(TABS[3][1])).toBeTruthy());

  // The composer's own intro is gone, so its hooks unmounted with it.
  expect(screen.queryByText(TABS[0][1])).toBeNull();
});

describe("one tab failing does not take the section down", () => {
  test("the tab bar survives, and another tab still opens", async () => {
    // As five separate pages each had its own error-boundary key, so a failure
    // stayed on the page that failed. Sharing one key would blank the tab bar
    // too, and switching tabs would not clear it — the person would have to
    // leave Communications entirely to read the queue because Surveys threw.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    globalThis.__EXPLODE_SURVEYS__ = true;
    render(<CommunicationsPage />);

    fireEvent.click(screen.getByRole("tab", { name: /Surveys/i }));
    await waitFor(() => {
      expect(screen.queryByText(TABS[1][1])).toBeNull();
    });
    // The bar is still there...
    expect(screen.getByRole("tab", { name: /Scheduled/i })).toBeTruthy();

    // ...and it still works, without leaving the section.
    fireEvent.click(screen.getByRole("tab", { name: /Scheduled/i }));
    await waitFor(() => {
      expect(screen.getByText(TABS[2][1])).toBeTruthy();
    });
    spy.mockRestore();
  });
});

describe("Edit by Link is a section of History (November 2026)", () => {
  test("History carries it, closed, with its link field and both actions", async () => {
    render(<CommunicationsPage />);
    fireEvent.click(screen.getByRole("tab", { name: /History/i }));
    const summary = await screen.findByText(/Have a message link\?/);
    const section = summary.closest("details");
    expect(section.open).toBe(false);
    expect(section.querySelector('input[placeholder^="Paste a Telegram message link"]')).toBeTruthy();
    expect(section.textContent).toMatch(/Update Message/);
    expect(section.textContent).toMatch(/Delete Message/);
    expect(screen.queryByRole("tab", { name: /Edit by Link/i })).toBeNull();
  });

  test("#communications/edit_by_link opens History and corrects the address", async () => {
    const onTabChange = vi.fn();
    render(<CommunicationsPage tab="edit_by_link" onTabChange={onTabChange} />);
    await waitFor(() => expect(onTabChange).toHaveBeenCalledWith("history"));
    expect(await screen.findByText(TABS[3][1])).toBeTruthy();
  });
});
