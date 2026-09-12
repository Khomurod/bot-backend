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
});

const TABS = [
  ["Send Message", /Send messages and media to multiple driver groups/i],
  ["Surveys", /Create and manage driver feedback surveys/i],
  ["Scheduled", /Messages queued for future delivery/i],
  ["History", /Every message the bot has sent/i],
  ["Edit by Link", /Edit or delete a message the bot previously sent/i],
];

test("opens on Send Message", async () => {
  render(<CommunicationsPage />);
  expect(screen.getByRole("heading", { name: /Communications/i })).toBeTruthy();
  await waitFor(() => {
    expect(screen.getByText(TABS[0][1])).toBeTruthy();
  });
});

for (const [label, intro] of TABS) {
  test(`the ${label} tab resolves, mounts, and brings no second header`, async () => {
    render(<CommunicationsPage />);
    fireEvent.click(screen.getByRole("button", { name: new RegExp(label, "i") }));
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

  fireEvent.click(screen.getByRole("button", { name: /History/i }));
  await waitFor(() => expect(screen.getByText(TABS[3][1])).toBeTruthy());

  // The composer's own intro is gone, so its hooks unmounted with it.
  expect(screen.queryByText(TABS[0][1])).toBeNull();
});
