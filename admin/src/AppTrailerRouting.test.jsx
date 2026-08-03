/**
 * /trailers is the Trailer Department's public-facing slug.
 *
 * These tests drive the real App shell in jsdom, so they cover what a user
 * actually does: opening /trailers directly, refreshing on a deep link, landing
 * on an old /admin/trailers bookmark, logging in against a requested page, and
 * moving back and forward through history.
 *
 * The department's status request never settles on purpose — the shell stays on
 * its spinner, so these tests exercise routing without pulling in every section
 * page and its data fetches.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("./api", () => ({
  verifyAuth: vi.fn(),
  logout: vi.fn(),
  login: vi.fn(),
  getSettings: vi.fn(async () => ({})),
}));
vi.mock("./api/trailerDepartment", () => {
  const status = vi.fn(() => new Promise(() => {})); // never settles: stays "checking"
  return { status, default: { status } };
});

const FULL_ADMIN = {
  valid: true,
  username: "admin",
  permissions: ["admin.full_access"],
  role_keys: ["super_admin"],
};
const TRAILER_ONLY = {
  valid: true,
  username: "trailer-manager",
  permissions: ["trailers.view", "trailer_rentals.view", "trailer_payments.view"],
  role_keys: ["trailer_manager"],
};

let App;
let api;

beforeEach(async () => {
  api = await import("./api");
  App = (await import("./App")).default;
});

afterEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  window.history.replaceState({}, "", "/");
});

function renderAt(pathname, session = FULL_ADMIN) {
  localStorage.setItem("token", "a.valid.token");
  api.verifyAuth.mockResolvedValue(session);
  window.history.replaceState({}, "", pathname);
  return render(<App />);
}

/** The Trailer Department shell is on screen (its brand header renders). */
const departmentVisible = () =>
  waitFor(() => expect(screen.getByText("Rental and Asset Management")).toBeInTheDocument());

/** The sidebar sub-item for `label` is the highlighted one. */
function activeSubItem() {
  const active = document.querySelector(".nav-subitem.active");
  return active ? active.textContent : null;
}

describe("opening /trailers", () => {
  test("a full administrator lands in the department at the default section", async () => {
    renderAt("/trailers");
    await departmentVisible();
    expect(window.location.pathname).toBe("/trailers");
    await waitFor(() => expect(activeSubItem()).toContain("Home"));
  });

  test("a deep link opens its section directly (a refresh does the same)", async () => {
    renderAt("/trailers/money");
    await departmentVisible();
    expect(window.location.pathname).toBe("/trailers/money");
    await waitFor(() => expect(activeSubItem()).toContain("Money"));
  });

  test("a trailer-only account lands in the department, not the admin home", async () => {
    renderAt("/trailers/rentals", TRAILER_ONLY);
    await departmentVisible();
    expect(window.location.pathname).toBe("/trailers/rentals");
    // No full-admin navigation leaks in.
    expect(screen.queryByText("Dispatch Center")).toBeNull();
  });

  test("an unknown section falls back to Home instead of a blank page", async () => {
    renderAt("/trailers/not-a-section");
    await departmentVisible();
    await waitFor(() => expect(activeSubItem()).toContain("Home"));
  });
});

describe("backward compatibility with /admin/trailers", () => {
  test("an old bookmark is rewritten to /trailers, keeping its section", async () => {
    renderAt("/admin/trailers/money");
    await departmentVisible();
    await waitFor(() => expect(window.location.pathname).toBe("/trailers/money"));
    await waitFor(() => expect(activeSubItem()).toContain("Money"));
  });

  test("a legacy section key keeps its record, filters and sub-tab", async () => {
    renderAt("/admin/trailers/map?trailer=42&status=active");
    await departmentVisible();
    await waitFor(() => expect(window.location.pathname).toBe("/trailers/trailers"));
    const params = new URLSearchParams(window.location.search);
    expect(params.get("trailer")).toBe("42");
    expect(params.get("status")).toBe("active");
    expect(params.get("tab")).toBe("map"); // /admin/trailers/map meant the map tab
  });

  test("the bare /admin/trailers root still resolves", async () => {
    renderAt("/admin/trailers");
    await departmentVisible();
    await waitFor(() => expect(window.location.pathname).toBe("/trailers/home"));
  });
});

describe("history", () => {
  test("back and forward move between sections", async () => {
    const user = userEvent.setup();
    renderAt("/trailers/home");
    await departmentVisible();

    await user.click(screen.getByRole("button", { name: /Money/ }));
    await waitFor(() => expect(window.location.pathname).toBe("/trailers/money"));

    window.history.back();
    await waitFor(() => expect(window.location.pathname).toBe("/trailers/home"));
    await waitFor(() => expect(activeSubItem()).toContain("Home"));

    window.history.forward();
    await waitFor(() => expect(window.location.pathname).toBe("/trailers/money"));
    await waitFor(() => expect(activeSubItem()).toContain("Money"));
  });

  test("the rewritten legacy URL is not a back-button trap", async () => {
    renderAt("/admin/trailers/money");
    await departmentVisible();
    await waitFor(() => expect(window.location.pathname).toBe("/trailers/money"));
    // replaceState, so the legacy entry is gone: going back leaves the app
    // rather than bouncing through /admin/trailers/money again.
    window.history.back();
    await waitFor(() => expect(window.location.pathname).not.toBe("/admin/trailers/money"));
  });
});

// Login redirection lives in AppTrailerLogin.test.jsx: jsdom keeps ONE session
// history per file, and the back/forward test above leaves entries behind that
// a later test's replaceState cannot undo.
