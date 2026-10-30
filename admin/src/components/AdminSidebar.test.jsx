/**
 * The sidebar after the October 2026 redesign.
 *
 * Every page key has exactly one sidebar entry, in the five groups of
 * docs/redesign/structure.md; an account without admin.full_access sees none;
 * Sign Out still signs out; the theme switch only changes the theme.
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
  const handlers = { onNavigateToPage: vi.fn(), onLogout: vi.fn(), onChangePassword: vi.fn() };
  render(<AdminSidebar session={admin} page="groups" mobileMenuOpen={false} {...handlers} {...props} />);
  return handlers;
}

describe("AdminSidebar", () => {
  test("every page key has exactly one entry, in the five groups", () => {
    const keys = NAV_SECTIONS.flatMap((s) => s.items.map((i) => i.key));
    expect([...keys].sort()).toEqual([...PAGE_KEYS].sort());
    expect(NAV_SECTIONS.map((s) => s.label)).toEqual(["Drivers", "Recruiting", "Communications", "Monitoring", "Administration"]);
    expect(NAV_SECTIONS.map((s) => s.items.map((i) => i.label))).toEqual([
      ["Driver Groups", "Live Locations", "Home Time", "Mileage Bonuses", "Retention"],
      ["Leads", "Customer Inquiries", "Recruiter KPIs"],
      ["Messages", "Birthdays"],
      ["Needs Attention", "System Health"],
      ["Telegram Users", "Settings"],
    ]);
  });

  test("an entry opens its page and the open page is marked current", async () => {
    const { onNavigateToPage } = renderSidebar();
    expect(screen.getByRole("button", { name: "Driver Groups" })).toHaveAttribute("aria-current", "page");
    await userEvent.click(screen.getByRole("button", { name: "Recruiter KPIs" }));
    expect(onNavigateToPage).toHaveBeenCalledWith("recruiter_kpis");
  });

  test("an account without admin.full_access sees no sections, but can still sign out", async () => {
    const { onLogout } = renderSidebar({ session: { username: "anna", permissions: [] } });
    expect(screen.queryByRole("button", { name: "Driver Groups" })).toBeNull();
    expect(screen.getByText("Limited access")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Sign Out" }));
    expect(onLogout).toHaveBeenCalledTimes(1);
  });

  test("every signed-in account can change its own password — limited access included", async () => {
    const { onChangePassword, onLogout } = renderSidebar({ session: { username: "anna", permissions: [] } });
    await userEvent.click(screen.getByRole("button", { name: "Change password" }));
    expect(onChangePassword).toHaveBeenCalledTimes(1);
    expect(onLogout).not.toHaveBeenCalled();
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
    expect(labelForPage("settings")).toBe("Settings");
    expect(labelForPage("system_health")).toBe("System Health");
    expect(labelForPage("nope")).toBe(null);
  });
});
