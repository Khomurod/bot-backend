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
import { render, screen, waitFor, within } from "@testing-library/react";
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

  test("#communications opens Messages on first load", async () => {
    goTo("#communications");
    await renderShell();
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /^Messages$/i })).toBeTruthy();
    });
  });

  test("a hash with a tab opens that tab", async () => {
    goTo("#communications/scheduled");
    await renderShell();
    const scheduled = await screen.findByRole("tab", { name: "Scheduled" });
    expect(scheduled).toHaveAttribute("aria-selected", "true");
  });

  test("#broadcast — a retired key — opens its own tab and is rewritten to the new address", async () => {
    goTo("#broadcast");
    await renderShell();
    const send = await screen.findByRole("tab", { name: "Send Message" });
    expect(send).toHaveAttribute("aria-selected", "true");
    await waitFor(() => expect(window.location.hash).toBe("#communications/send"));
  });

  test("#settings_board — an old Settings entry — opens the Dispatcher Board section", async () => {
    goTo("#settings_board");
    await renderShell();
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /Dispatcher Board/i })).toBeTruthy();
    });
    await waitFor(() => expect(window.location.hash).toBe("#settings/board"));
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
    await userEvent.click(screen.getByRole("button", { name: /Live Locations/i }));
    await waitFor(() => expect(window.location.hash).toBe("#live_locations"));
    expect(window.location.pathname).toBe("/admin");
  });

  test("signing out clears the hash", async () => {
    goTo("#settings_ai");
    await renderShell();
    await userEvent.click(screen.getByRole("button", { name: /Sign Out/i }));
    await waitFor(() => expect(window.location.hash).toBe(""));
  });
});

describe("tabs and sections have addresses", () => {
  /**
   * Until October 2026 six sidebar entries opened one Settings page on six
   * tabs, and a tab changed inside the page reached neither the address nor
   * the highlight. Now one entry opens Settings and the section is in the
   * address; the same for every tabbed page.
   */
  test("choosing a Settings section changes the section AND the address", async () => {
    goTo("#settings/board");
    await renderShell();
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /Dispatcher Board/i })).toBeTruthy();
    });

    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    await userEvent.click(within(nav).getByRole("button", { name: "AI & Autonomy" }));
    await waitFor(() => expect(window.location.hash).toBe("#settings/ai"));
    await waitFor(() => {
      // The Dispatcher Board card is gone, so the section really moved.
      expect(screen.queryByRole("heading", { name: /Dispatcher Board/i })).toBeNull();
    });
    // And the sidebar still says where you are: one entry for all of Settings.
    expect(screen.getByRole("button", { name: "Settings" })).toHaveAttribute("aria-current", "page");
  });

  test("a Needs Attention tab writes its address", async () => {
    goTo("#operations");
    await renderShell();
    // Wait for the page itself — the sidebar renders before the lazy page.
    const history = await screen.findByRole("tab", { name: "History" });
    await userEvent.click(history);
    await waitFor(() => expect(window.location.hash).toBe("#operations/history"));
    expect(screen.getByRole("tab", { name: "History" })).toHaveAttribute("aria-selected", "true");
  });

  test("System Health and Retention are pages of their own", async () => {
    goTo("#operations");
    await renderShell();
    await screen.findByRole("tab", { name: /^Needs attention$/i });

    await userEvent.click(screen.getByRole("button", { name: "System Health" }));
    await waitFor(() => expect(window.location.hash).toBe("#system_health"));
    expect(await screen.findByRole("heading", { name: "System Health" })).toBeTruthy();
    // Not Needs Attention on another tab: its tab bar is gone.
    expect(screen.queryByRole("tab", { name: /^Needs attention$/i })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Retention" }));
    await waitFor(() => expect(window.location.hash).toBe("#retention"));
    expect(await screen.findByRole("heading", { name: "Driver Retention" })).toBeTruthy();
  });

  test("an unknown tab opens the first one, and the address is corrected to say so", async () => {
    goTo("#settings/bogus");
    await renderShell();
    await waitFor(() => expect(window.location.hash).toBe("#settings/location"));
    const nav = await screen.findByRole("navigation", { name: "Settings sections" });
    expect(within(nav).getByRole("button", { name: "Location Providers" })).toHaveAttribute("aria-current", "page");
  });

  test("a tab change keeps the query string (?dev=1 is what shows the Activity Log tab)", async () => {
    window.history.replaceState({}, "", "/admin?dev=1#facebook_leads");
    await renderShell();
    await userEvent.click(await screen.findByRole("tab", { name: "Connected Pages" }));
    await waitFor(() => expect(window.location.hash).toBe("#facebook_leads/pages"));
    expect(window.location.search).toBe("?dev=1");
    // Still offered: dropping `?dev=1` is what used to take it away.
    expect(screen.getByRole("tab", { name: "Activity Log" })).toBeTruthy();
  });

  test("Home Time's configuration is on its own tab, with its own address", async () => {
    goTo("#home_time");
    await renderShell();
    const settingsTab = await screen.findByRole("tab", { name: "Settings & Alerts" });
    await userEvent.click(settingsTab);
    await waitFor(() => expect(window.location.hash).toBe("#home_time/settings"));
    expect(screen.getByRole("tab", { name: "Settings & Alerts" })).toHaveAttribute("aria-selected", "true");
  });

  test("Birthdays holds the employees, and Telegram Users points there", async () => {
    goTo("#users");
    await renderShell();
    const link = await screen.findByRole("link", { name: /Birthdays → Employees/i });
    expect(link).toHaveAttribute("href", "#company_birthdays/employees");

    goTo("#company_birthdays/employees");
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    const employees = await screen.findByRole("tab", { name: "Employees" });
    expect(employees).toHaveAttribute("aria-selected", "true");
  });
});

describe("account controls", () => {
  test("Change password in the sidebar opens the dialog, and Cancel closes it", async () => {
    await renderShell();
    await userEvent.click(screen.getByRole("button", { name: "Change password" }));
    expect(screen.getByRole("dialog", { name: "Change password" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: "Change password" })).toBeNull();
  });

  test("#settings/admins opens Admin Accounts", async () => {
    goTo("#settings/admins");
    await renderShell();
    await waitFor(() => expect(screen.getByRole("region", { name: "Admin Accounts" })).toBeTruthy());
  });
});
