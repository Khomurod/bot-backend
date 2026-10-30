/**
 * The sidebar after the October 2026 redesign.
 *
 * The redesign changed how the sidebar looks, not where anything is: every
 * page key still has exactly one sidebar entry, an account without
 * admin.full_access still sees none, Sign Out still signs out, and the new
 * theme switch only changes the theme.
 */
import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AdminSidebar, { NAV_SECTIONS, labelForPage } from "./AdminSidebar";
import { PAGE_KEYS } from "../navigation/pageKeys";

const admin = { username: "owner", permissions: ["admin.full_access"] };

const originalMatchMedia = window.matchMedia;

afterEach(() => {
  window.matchMedia = originalMatchMedia;
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

function renderSidebar(props = {}) {
  const handlers = { onNavigateToPage: vi.fn(), onLogout: vi.fn() };
  render(<AdminSidebar session={admin} page="groups" mobileMenuOpen={false} {...handlers} {...props} />);
  return handlers;
}

describe("AdminSidebar", () => {
  test("every page key has exactly one entry, in the five sections", () => {
    const keys = NAV_SECTIONS.flatMap((s) => s.items.map((i) => i.key));
    expect([...keys].sort()).toEqual([...PAGE_KEYS].sort());
    expect(NAV_SECTIONS.map((s) => s.label)).toEqual(["Operations", "Groups", "Communications", "Recruiting", "Settings"]);
  });

  test("an entry opens its page and the open page is marked current", async () => {
    const { onNavigateToPage } = renderSidebar();
    expect(screen.getByRole("button", { name: "Groups" })).toHaveAttribute("aria-current", "page");
    await userEvent.click(screen.getByRole("button", { name: "Recruiter KPIs" }));
    expect(onNavigateToPage).toHaveBeenCalledWith("recruiter_kpis");
  });

  test("an account without admin.full_access sees no sections, but can still sign out", async () => {
    const { onLogout } = renderSidebar({ session: { username: "anna", permissions: [] } });
    expect(screen.queryByRole("button", { name: "Groups" })).toBeNull();
    expect(screen.getByText("Limited access")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Sign Out" }));
    expect(onLogout).toHaveBeenCalledTimes(1);
  });

  test("the theme switch flips the theme and touches nothing else", async () => {
    window.matchMedia = vi.fn(() => ({ matches: false }));
    const { onNavigateToPage, onLogout } = renderSidebar();
    await userEvent.click(screen.getByRole("button", { name: "Dark mode" }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    await userEvent.click(screen.getByRole("button", { name: "Light mode" }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(onNavigateToPage).not.toHaveBeenCalled();
    expect(onLogout).not.toHaveBeenCalled();
  });

  test("with no choice stored, the switch follows the operating system", () => {
    let listener = null;
    window.matchMedia = vi.fn(() => ({
      matches: true,
      addEventListener: (_type, fn) => { listener = fn; },
      removeEventListener: () => { listener = null; },
    }));
    renderSidebar();
    expect(screen.getByRole("button", { name: "Light mode" })).toBeTruthy();
    act(() => listener({ matches: false }));
    expect(screen.getByRole("button", { name: "Dark mode" })).toBeTruthy();
  });

  test("the phone top bar's title is the sidebar label", () => {
    expect(labelForPage("settings_ai")).toBe("AI & Autonomy");
    expect(labelForPage("nope")).toBe(null);
  });
});
