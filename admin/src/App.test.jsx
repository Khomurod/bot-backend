/**
 * The admin shell's routing — the part that is new in this stage.
 *
 * Until now `/admin` was the ONLY url the panel ever produced: `getPathForPage`
 * ignored its argument and returned that string, so no admin screen could be
 * bookmarked, pasted into a chat, or reached with the Back button. The page was
 * in-memory state and nothing else.
 *
 * So these tests are about the URL, not about any page's contents:
 *
 *   - a hash opens the screen it names, on first load, with no clicking;
 *   - a hash held over from before a page moved opens where its content WENT,
 *     rather than silently falling back to Driver Groups — which is what a
 *     wrong link looks like, and the reason LEGACY_PAGE_KEYS exists;
 *   - clicking a nav item writes a hash somebody can come back to;
 *   - signing out drops it, so the next person does not land on whatever the
 *     last one was looking at.
 */
import React from "react";
import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Every page behind the shell fetches on mount. None of that is what is under
// test, so the whole api facade answers empty.
//
// The real module is imported to get its EXPORT NAMES — a bare Proxy does not
// work here, because an ES module namespace built from one has no own keys, so
// `api.verifyAuth` reads as undefined and the shell renders the login form
// instead of the panel. Only the names are borrowed; every implementation is a
// stub.
vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal();
  const stubbed = {};
  for (const name of Object.keys(actual)) {
    stubbed[name] = typeof actual[name] === "function"
      ? vi.fn().mockResolvedValue([])
      : actual[name];
  }
  stubbed.verifyAuth = vi.fn().mockResolvedValue({
    id: 1, username: "admin", permissions: ["admin.full_access"],
  });
  stubbed.logout = vi.fn();
  return stubbed;
});

import App from "./App";

function goTo(hash) {
  window.history.replaceState({}, "", `/admin${hash}`);
}

beforeEach(() => {
  localStorage.setItem("token", "test-token");
  goTo("");
});

afterEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});

/** The shell renders the sidebar once the auth check resolves. */
async function renderShell() {
  const view = render(<App />);
  await waitFor(() => expect(screen.getByText("Sign Out")).toBeTruthy());
  return view;
}

describe("a hash opens the page it names", () => {
  test("with no hash, the shell opens on Driver Groups as it always has", async () => {
    await renderShell();
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /Driver Groups/i })).toBeTruthy();
    });
  });

  test("#communications opens Communications on first load", async () => {
    goTo("#communications");
    await renderShell();
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /Communications/i })).toBeTruthy();
    });
  });

  test("#broadcast — retired in the stage before this one — opens Communications too", async () => {
    goTo("#broadcast");
    await renderShell();
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /Communications/i })).toBeTruthy();
    });
  });

  test("a hash naming nothing opens Driver Groups rather than a blank shell", async () => {
    goTo("#not_a_page");
    await renderShell();
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /Driver Groups/i })).toBeTruthy();
    });
  });
});

describe("the URL follows the navigation", () => {
  test("clicking a nav item writes a hash that names the destination", async () => {
    await renderShell();
    await userEvent.click(screen.getByRole("button", { name: /Route Control/i }));
    await waitFor(() => expect(window.location.hash).toBe("#route_control"));
    expect(window.location.pathname).toBe("/admin");
  });

  test("signing out clears the hash", async () => {
    goTo("#settings_ai");
    await renderShell();
    await userEvent.click(screen.getByRole("button", { name: /Sign Out/i }));
    await waitFor(() => expect(window.location.hash).toBe(""));
  });
});

describe("two nav entries that are the same component", () => {
  /**
   * Integrations, Dispatcher Board and AI & Autonomy are ONE SettingsPage on
   * three tabs; Needs Attention and System & AI Health are one OperationsPage.
   * React reconciles same-type elements in the same position, so the tab —
   * read once in a useState initializer — would keep whatever it opened on
   * while the URL and the highlighted sidebar item both moved. The page would
   * say "Dispatcher Board" in the nav and show the AI tab.
   */
  test("moving between two Settings entries actually changes the tab", async () => {
    goTo("#settings_board");
    await renderShell();
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /Dispatcher Board/i })).toBeTruthy();
    });

    await userEvent.click(screen.getByRole("button", { name: /AI & Autonomy/i }));
    await waitFor(() => expect(window.location.hash).toBe("#settings_ai"));
    await waitFor(() => {
      // The Dispatcher Board card is gone, so the tab really moved.
      expect(screen.queryByRole("heading", { name: /Dispatcher Board/i })).toBeNull();
    });
  });

  test("moving between the two Operations entries actually changes the tab", async () => {
    goTo("#operations");
    await renderShell();

    // WAIT FOR THE PAGE TO BE ON SCREEN BEFORE CLICKING. The sidebar renders
    // before the lazy page resolves, so clicking as soon as "Sign Out" appears
    // can change `page` while OperationsPage is still suspended — it then
    // mounts fresh with initialTab="systems" and the assertion below passes
    // whether or not the key is there. This test did exactly that and proved
    // nothing until the wait was added.
    const needsAttention = await screen.findByRole("button", { name: /^Needs attention$/i });
    expect(needsAttention.className).toContain("btn-primary");

    await userEvent.click(screen.getByRole("button", { name: /System & AI Health/i }));
    await waitFor(() => expect(window.location.hash).toBe("#system_health"));
    await waitFor(() => {
      // btn-primary is the Operations tab bar's own "this one is open" class,
      // and Needs attention must have given it up.
      expect(screen.getByRole("button", { name: /What is running/i }).className)
        .toContain("btn-primary");
      expect(screen.getByRole("button", { name: /^Needs attention$/i }).className)
        .toContain("btn-ghost");
    });
  });
});
