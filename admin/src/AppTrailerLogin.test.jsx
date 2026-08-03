/**
 * Signing in must return the user to the trailer page they originally asked for.
 *
 * A trailer-only account used to be pushed to its DEFAULT section on every
 * login, so a deep link (or a bookmark that bounced through the login gate)
 * silently lost the section the user wanted.
 *
 * Its own file on purpose: jsdom keeps one session history per test file, and
 * the back/forward tests in AppTrailerRouting.test.jsx leave entries behind that
 * a later replaceState cannot undo.
 */
import React from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
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

const TRAILER_ONLY = {
  valid: true,
  username: "trailer-manager",
  permissions: ["trailers.view", "trailer_rentals.view", "trailer_payments.view"],
  role_keys: ["trailer_manager"],
};

let App;
let api;

beforeEach(async () => {
  localStorage.clear(); // no token: the login gate renders
  api = await import("./api");
  api.verifyAuth.mockResolvedValue(null);
  App = (await import("./App")).default;
});

afterEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});

/** Fill in and submit the login form. Its labels are not wired to the inputs. */
async function signIn(container) {
  const user = userEvent.setup();
  await screen.findByRole("button", { name: /sign in/i });
  await user.type(container.querySelector('input[type="text"]'), "trailer-manager");
  await user.type(container.querySelector('input[type="password"]'), "pw");
  await user.click(screen.getByRole("button", { name: /sign in/i }));
}

test("a trailer-only account returns to the section it requested", async () => {
  api.login.mockResolvedValue({ token: "t", ...TRAILER_ONLY });
  window.history.replaceState({}, "", "/trailers/money");

  const { container } = render(<App />);
  await signIn(container);

  await waitFor(() => expect(screen.getByText("Rental and Asset Management")).toBeInTheDocument());
  // NOT bounced to the default section — the requested one survives login.
  expect(window.location.pathname).toBe("/trailers/money");
});
