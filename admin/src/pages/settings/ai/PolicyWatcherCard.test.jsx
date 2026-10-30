/**
 * The terms watcher card, on the three things Phase 3-D changed for a person:
 * the pages are found for them (and say where they came from), the destination
 * can be tested with one click, and typing a URL is the exception, not the form.
 */
import React from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import PolicyWatcherCard from "./PolicyWatcherCard";
import * as api from "../../../api";

vi.mock("../../../api", () => ({
  getAiPolicyWatcher: vi.fn(),
  updateAiPolicyWatcher: vi.fn(),
  testAiPolicyNotification: vi.fn(),
  addAiPolicySource: vi.fn(),
  deleteAiPolicySource: vi.fn(),
  setAiPolicySourceEnabled: vi.fn(),
  acknowledgeAiPolicyFinding: vi.fn(),
  runAiPolicyCheck: vi.fn(),
}));

const DATA = {
  settings: { enabled: true, autoSuspendEnabled: false, notifyChatId: "-1001", notifyMinSeverity: "warning" },
  sources: [
    { id: 1, providerKey: "groq", kind: "terms", url: "https://groq.com/terms-of-use", sourceOrigin: "catalog", enabled: true },
    { id: 2, providerKey: "groq", kind: "privacy", url: "https://groq.com/privacy-policy", sourceOrigin: "rediscovered", movedFrom: "https://groq.com/privacy", enabled: true },
    { id: 3, providerKey: "groq", kind: "pricing", url: "https://groq.com/pricing", sourceOrigin: "manual", enabled: true, lostReportedAt: "2026-09-01T00:00:00Z", lastError: "HTTP 404" },
  ],
  findings: [],
  alerts: { exhausted: { count: 0 } },
};

async function open() {
  api.getAiPolicyWatcher.mockResolvedValue(DATA);
  render(<PolicyWatcherCard providers={[{ providerKey: "groq", label: "Groq" }]} flash={vi.fn()} />);
  await waitFor(() => expect(screen.getByText(/Pages being watched/)).toBeInTheDocument());
}

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.clearAllMocks(); });

test("each page says where its address came from, and a moved or lost page says so", async () => {
  await open();
  expect(screen.getByText("found automatically")).toBeInTheDocument();
  expect(screen.getByText("found again")).toBeInTheDocument();
  expect(screen.getByText("added by hand")).toBeInTheDocument();
  expect(screen.getByText(/moved from https:\/\/groq\.com\/privacy/)).toBeInTheDocument();
  expect(screen.getByText(/could not be found/)).toBeInTheDocument();
});

test("Send a test message uses the configured destination and reports the outcome", async () => {
  api.testAiPolicyNotification.mockResolvedValue({ ok: true, chatId: "-1001" });
  await open();
  fireEvent.click(screen.getByRole("button", { name: /Send a test message/ }));
  await waitFor(() => expect(api.testAiPolicyNotification).toHaveBeenCalledWith({ chatId: "-1001" }));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/Test message sent/));
});

test("a refused test message is shown as the reason", async () => {
  api.testAiPolicyNotification.mockResolvedValue({ ok: false, error: "chat not found" });
  await open();
  fireEvent.click(screen.getByRole("button", { name: /Send a test message/ }));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/chat not found/));
});

test("adding a URL by hand is tucked away, not the main form", async () => {
  await open();
  // Inside a closed <details>: present in the document, not shown until asked for.
  const url = screen.getByLabelText(/URL \(https\)/);
  expect(url).not.toBeVisible();
  const details = url.closest("details");
  expect(details).not.toBeNull();
  expect(details.open).toBe(false);
  details.open = true;
  expect(screen.getByLabelText(/URL \(https\)/)).toBeVisible();
});

test("testing a candidate destination does not save it first", async () => {
  // The input saves on blur; clicking the button would blur it. A destination
  // is meant to be proven BEFORE it becomes the configured one.
  const userEvent = (await import("@testing-library/user-event")).default;
  const user = userEvent.setup();
  api.testAiPolicyNotification.mockResolvedValue({ ok: false, error: "chat not found" });
  await open();
  const input = screen.getByPlaceholderText("-1002997837889");
  await user.clear(input);
  await user.type(input, "-2002");
  await user.click(screen.getByRole("button", { name: /Send a test message/ }));
  await waitFor(() => expect(api.testAiPolicyNotification).toHaveBeenCalledWith({ chatId: "-2002" }));
  expect(api.updateAiPolicyWatcher).not.toHaveBeenCalled();
});

test("unticking Watch stops a page being checked, without removing it", async () => {
  api.setAiPolicySourceEnabled.mockResolvedValue({ id: 1, enabled: false });
  await open();
  const watch = screen.getByRole("checkbox", { name: "Watch groq terms" });
  expect(watch).toBeChecked();

  fireEvent.click(watch);

  await waitFor(() => expect(api.setAiPolicySourceEnabled).toHaveBeenCalledWith(1, false));
  expect(api.deleteAiPolicySource).not.toHaveBeenCalled();
  // The list is read again, so the page shows its new state.
  await waitFor(() => expect(api.getAiPolicyWatcher).toHaveBeenCalledTimes(2));
});

test("a page that is not watched is shown unticked, and ticking it watches it again", async () => {
  api.getAiPolicyWatcher.mockResolvedValue({
    ...DATA, sources: [{ ...DATA.sources[0], enabled: false }],
  });
  api.setAiPolicySourceEnabled.mockResolvedValue({ id: 1, enabled: true });
  render(<PolicyWatcherCard providers={[{ providerKey: "groq", label: "Groq" }]} flash={vi.fn()} />);
  const watch = await screen.findByRole("checkbox", { name: "Watch groq terms" });
  expect(watch).not.toBeChecked();

  fireEvent.click(watch);

  await waitFor(() => expect(api.setAiPolicySourceEnabled).toHaveBeenCalledWith(1, true));
});
