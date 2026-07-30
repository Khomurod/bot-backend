/**
 * /answers/test test-data cleanup — the authentication paths.
 *
 * Covers every stored-token state the browser can be in (none, valid full
 * admin, expired/invalid, valid but limited such as a Trailer-only account),
 * the 401/403 fallback to the inline login, a successful full-admin login and
 * cleanup, the explicit confirmation and the double-click guard — and that the
 * control only ever calls the TEST cleanup, never the real one.
 *
 * No real credential appears here: the API module is mocked, so the "password"
 * values are inert test strings and no token is ever persisted.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import SosTestCleanup from "./SosTestCleanup";
import { clearSosTestData, sosAdminLogin } from "../../api/sos";

vi.mock("../../api/sos", () => ({
  clearSosTestData: vi.fn(),
  sosAdminLogin: vi.fn(),
  clearSosRealData: vi.fn(), // must never be reachable from this control
}));

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

const STORED = "stored.limited.token";

function open(props = {}) {
  const onCleared = vi.fn();
  render(<SosTestCleanup onCleared={onCleared} {...props} />);
  fireEvent.click(screen.getByRole("button", { name: /Tozalash boʻlimini ochish/ }));
  return { onCleared };
}

const cleanupButton = () => screen.getByRole("button", { name: /TEST javoblarini oʻchirish/ });
const loginFields = () => screen.queryByLabelText("Administrator login");

function typeCredentials(username = "fulladmin", password = "not-a-real-password") {
  fireEvent.change(screen.getByLabelText("Administrator login"), { target: { value: username } });
  fireEvent.change(screen.getByLabelText("Administrator parol"), { target: { value: password } });
}

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(window, "confirm").mockReturnValue(true);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  localStorage.clear();
});

describe("no stored token", () => {
  test("shows the login immediately and refuses to run without credentials", async () => {
    open();
    expect(loginFields()).toBeInTheDocument();
    fireEvent.click(cleanupButton());
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toMatch(/administrator login va parolini kiriting/i);
    });
    expect(clearSosTestData).not.toHaveBeenCalled();
  });

  test("a full-admin login then performs the cleanup", async () => {
    sosAdminLogin.mockResolvedValue("fresh.full.admin.token");
    clearSosTestData.mockResolvedValue({ deleted: 4, mode: "test" });
    const { onCleared } = open();
    typeCredentials();
    fireEvent.click(cleanupButton());

    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/4 ta TEST javobi/));
    expect(sosAdminLogin).toHaveBeenCalledWith("fulladmin", "not-a-real-password");
    expect(clearSosTestData).toHaveBeenCalledWith("fresh.full.admin.token");
    expect(onCleared).toHaveBeenCalledTimes(1);
    // the token stays in memory: nothing was written to storage
    expect(localStorage.getItem("token")).toBeNull();
    // and the password field is cleared once exchanged for a token
    expect(screen.getByLabelText("Administrator parol").value).toBe("");
  });

  test("a rejected login reports the failure and stays on the login", async () => {
    sosAdminLogin.mockRejectedValue(httpError(401, "Invalid credentials"));
    open();
    typeCredentials();
    fireEvent.click(cleanupButton());
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/Kirish amalga oshmadi/));
    expect(clearSosTestData).not.toHaveBeenCalled();
    expect(loginFields()).toBeInTheDocument();
  });
});

describe("stored token", () => {
  test("a valid full-admin token is reused without asking for a password", async () => {
    localStorage.setItem("token", "stored.full.admin.token");
    clearSosTestData.mockResolvedValue({ deleted: 2, mode: "test" });
    open();
    expect(loginFields()).toBeNull();
    fireEvent.click(cleanupButton());
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/2 ta TEST javobi/));
    expect(clearSosTestData).toHaveBeenCalledWith("stored.full.admin.token");
    expect(sosAdminLogin).not.toHaveBeenCalled();
  });

  test("a 403 from a valid but LIMITED token reveals the login and explains why", async () => {
    localStorage.setItem("token", STORED);
    clearSosTestData.mockRejectedValueOnce(httpError(403, "Missing permission: admin.full_access"));
    open();
    expect(loginFields()).toBeNull();
    fireEvent.click(cleanupButton());

    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/yetarli ruxsat yoʻq/));
    expect(loginFields()).toBeInTheDocument(); // no dead end
  });

  test("a 401 from an expired or invalid token reveals the login too", async () => {
    localStorage.setItem("token", "expired.token");
    clearSosTestData.mockRejectedValueOnce(httpError(401, "Invalid token"));
    open();
    fireEvent.click(cleanupButton());
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/Sessiya tugagan/));
    expect(loginFields()).toBeInTheDocument();
  });

  test("after a 403 the full-admin login succeeds and the cleanup runs", async () => {
    localStorage.setItem("token", STORED);
    clearSosTestData
      .mockRejectedValueOnce(httpError(403, "Missing permission: admin.full_access"))
      .mockResolvedValueOnce({ deleted: 6, mode: "test" });
    sosAdminLogin.mockResolvedValue("fresh.full.admin.token");
    const { onCleared } = open();

    fireEvent.click(cleanupButton());
    await waitFor(() => expect(loginFields()).toBeInTheDocument());

    typeCredentials();
    fireEvent.click(cleanupButton());
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/6 ta TEST javobi/));

    // the rejected stored token was dropped, the fresh one was used
    expect(clearSosTestData).toHaveBeenNthCalledWith(1, STORED);
    expect(clearSosTestData).toHaveBeenNthCalledWith(2, "fresh.full.admin.token");
    expect(onCleared).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem("token")).toBe(STORED); // the shared token is left alone
  });

  test("the in-memory token is reused for a second cleanup without re-typing", async () => {
    localStorage.setItem("token", STORED);
    clearSosTestData
      .mockRejectedValueOnce(httpError(403, "Missing permission: admin.full_access"))
      .mockResolvedValue({ deleted: 1, mode: "test" });
    sosAdminLogin.mockResolvedValue("fresh.full.admin.token");
    open();
    fireEvent.click(cleanupButton());
    await waitFor(() => expect(loginFields()).toBeInTheDocument());
    typeCredentials();
    fireEvent.click(cleanupButton());
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/1 ta TEST javobi/));

    fireEvent.click(cleanupButton()); // no credentials typed this time
    await waitFor(() => expect(clearSosTestData).toHaveBeenCalledTimes(3));
    expect(clearSosTestData).toHaveBeenNthCalledWith(3, "fresh.full.admin.token");
    expect(sosAdminLogin).toHaveBeenCalledTimes(1);
  });

  test("an operator can switch to another admin account before any error", async () => {
    localStorage.setItem("token", STORED);
    open();
    fireEvent.click(screen.getByRole("button", { name: /Boshqa administrator hisobi bilan kirish/ }));
    expect(loginFields()).toBeInTheDocument();
    sosAdminLogin.mockResolvedValue("other.full.admin.token");
    clearSosTestData.mockResolvedValue({ deleted: 0, mode: "test" });
    typeCredentials("other-admin");
    fireEvent.click(cleanupButton());
    await waitFor(() => expect(clearSosTestData).toHaveBeenCalledWith("other.full.admin.token"));
  });

  test("a blank stored token counts as no token at all", () => {
    localStorage.setItem("token", "   ");
    open();
    expect(loginFields()).toBeInTheDocument();
  });
});

describe("safety", () => {
  test("cancelling the confirmation deletes nothing", () => {
    window.confirm.mockReturnValue(false);
    localStorage.setItem("token", "stored.full.admin.token");
    open();
    fireEvent.click(cleanupButton());
    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(clearSosTestData).not.toHaveBeenCalled();
  });

  test("a double click runs the cleanup once", async () => {
    localStorage.setItem("token", "stored.full.admin.token");
    let release;
    clearSosTestData.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    open();
    const button = cleanupButton();
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);
    expect(clearSosTestData).toHaveBeenCalledTimes(1);
    expect(button).toBeDisabled();
    await act(async () => { release({ deleted: 1, mode: "test" }); });
    expect(clearSosTestData).toHaveBeenCalledTimes(1);
  });

  test("real SOS data is never touched: only the TEST endpoint is ever called", async () => {
    const api = await import("../../api/sos");
    localStorage.setItem("token", "stored.full.admin.token");
    clearSosTestData.mockResolvedValue({ deleted: 3, mode: "test" });
    open();
    fireEvent.click(cleanupButton());
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/tegilmadi/));
    expect(api.clearSosRealData).not.toHaveBeenCalled();
  });

  test("a server error is reported without leaking the token", async () => {
    localStorage.setItem("token", "stored.full.admin.token");
    clearSosTestData.mockRejectedValue(new Error("Server error"));
    open();
    fireEvent.click(cleanupButton());
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/Oʻchirib boʻlmadi/));
    expect(screen.getByRole("alert").textContent).not.toMatch(/stored\.full\.admin\.token/);
  });
});
