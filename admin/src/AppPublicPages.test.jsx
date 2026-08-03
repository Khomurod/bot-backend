/**
 * Public URLs must not be moved by whatever token happens to sit in the browser.
 *
 * A Trailer-only account (valid token, no admin.full_access) used to be
 * auto-navigated into the Trailer department on load. On /answers and
 * /answers/test that hijacked the public SOS presentation — the page silently
 * became the Trailer department, so the projector view and the test-data cleanup
 * were unreachable for exactly the account the cleanup fallback exists for.
 *
 * These tests pin that public pages stay put, while the admin entry point still
 * gets the convenience redirect.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

vi.mock("./api", () => ({
  verifyAuth: vi.fn(),
  logout: vi.fn(),
  getSettings: vi.fn(async () => ({})),
}));
vi.mock("./api/sos", () => ({
  getSosSummary: vi.fn(async () => null), // keeps the page on its spinner
  getSosMeta: vi.fn(async () => ({ open: false, departments: [], dispatchTeams: [] })),
  clearSosTestData: vi.fn(),
  sosAdminLogin: vi.fn(),
}));

const TRAILER_ONLY = {
  valid: true,
  username: "trailer-manager",
  permissions: ["trailers.view", "trailer_users.manage"],
  role_keys: ["trailer_manager"],
};

let App;
let api;

beforeEach(async () => {
  localStorage.setItem("token", "valid.trailer.only.token");
  api = await import("./api");
  api.verifyAuth.mockResolvedValue(TRAILER_ONLY);
  App = (await import("./App")).default;
});

afterEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  window.history.replaceState({}, "", "/");
});

function renderAt(pathname) {
  window.history.replaceState({}, "", pathname);
  return render(<App />);
}

describe.each(["/answers", "/answers/test", "/questions", "/questions/test"])(
  "%s with a valid Trailer-only token",
  (pathname) => {
    test("stays on the public page and never redirects to the Trailer department", async () => {
      renderAt(pathname);
      await waitFor(() => expect(api.verifyAuth).toHaveBeenCalled());
      // give the (previously redirecting) effect every chance to fire
      await waitFor(() => expect(window.location.pathname).toBe(pathname));
      expect(screen.queryByText(/Trailer/i)).toBeNull();
    });
  },
);

describe("the admin entry point", () => {
  test("still sends a Trailer-only account into the Trailer department", async () => {
    renderAt("/admin");
    // /trailers is the department's canonical slug.
    await waitFor(() => expect(window.location.pathname).toMatch(/^\/trailers/));
  });
});
