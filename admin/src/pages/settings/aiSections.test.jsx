/**
 * Settings → AI, split into four sections in November 2026 (it was one
 * "AI & Autonomy" screen of 6.6 desktop screens).
 *
 * What a split breaks, pinned here: a card left on no section; a card shown on
 * two; a section that cannot reach the data it used to be handed (the learning
 * switch, the provider list); and a save that reports into no banner.
 * Each card's own test covers what the card does.
 */
import React from "react";
import { beforeEach, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as api from "../../api";
import AiTab from "./AiTab";
import AiTasksTab from "./AiTasksTab";
import WenzeQuestionsTab from "./WenzeQuestionsTab";
import ProviderTermsTab from "./ProviderTermsTab";

vi.mock("../../api", () => ({
  getAiSettings: vi.fn(),
  updateAiSettings: vi.fn(),
  getAiResponsibilities: vi.fn(),
  updateAiCapability: vi.fn(),
  updateOperationsCheck: vi.fn(),
  getAiLessons: vi.fn(),
  removeAiLesson: vi.fn(),
  skipAiLearningQuestion: vi.fn(),
  getAiPolicyWatcher: vi.fn(),
  updateAiPolicyWatcher: vi.fn(),
  getControlSettings: vi.fn(),
  updateControlSettings: vi.fn(),
  addControlOperator: vi.fn(),
  removeControlOperator: vi.fn(),
  forgetControlAnswer: vi.fn(),
}));

const SETTINGS = {
  settings: { enabled: true, freeOnlyMode: true, routingMode: "priority", requestTimeoutMs: 60000, learningEnabled: true },
  providers: [], health: [], recentFailures: [], modelEvents: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  api.getAiSettings.mockResolvedValue(SETTINGS);
  api.getAiResponsibilities.mockResolvedValue({
    groups: [{
      group: "Home Time",
      capabilities: [{
        key: "home_time_intent", label: "Understand Home Time requests", what: "Reads a message.",
        changesState: true, stateNote: "Can open a request.", fallback: "Exact wording only.", aiEnabled: true,
      }],
    }],
    automationError: null,
  });
  api.getAiLessons.mockResolvedValue({ lessons: [], current: null, counts: { queued: 0, asked: 0, answered: 0, skipped: 0 }, scopes: {} });
  api.getAiPolicyWatcher.mockResolvedValue({
    settings: { enabled: false, autoSuspendEnabled: false, notifyChatId: "", notifyMinSeverity: "warning" },
    sources: [], findings: [], alerts: { exhausted: { count: 0 } },
  });
  api.getControlSettings.mockResolvedValue({
    settings: { enabled: true, maxQuestionsPerPass: 5, repeatAfterHours: 72, clarifyLimit: 1 },
    operators: [], replies: { available: true, total: 0, refused: 0, last7d: 0 }, knowledge: [],
  });
});

test("AI Providers keeps the switches and providers, and nothing that moved out", async () => {
  render(<AiTab />);
  expect(await screen.findByText(/How AI is used/)).toBeTruthy();
  expect(screen.getByText(/Health, last 24 hours/)).toBeTruthy();
  expect(api.getAiResponsibilities).not.toHaveBeenCalled();
  expect(api.getAiLessons).not.toHaveBeenCalled();
  expect(api.getAiPolicyWatcher).not.toHaveBeenCalled();
});

test("AI Tasks shows each task in one row, its reasons behind How it works", async () => {
  render(<AiTasksTab />);
  expect(await screen.findByText("Understand Home Time requests")).toBeTruthy();
  const details = screen.getByText("How it works").closest("details");
  expect(details.open).toBe(false);
  expect(details.textContent).toMatch(/Can open a request\./);
  expect(details.textContent).toMatch(/With AI off:.*Exact wording only\./);
  // The switch itself is not hidden.
  expect(screen.getByRole("checkbox", { name: /AI analysis/ })).toBeTruthy();
});

test("Wenze's Questions holds both ways Wenze asks, and both report into its banner", async () => {
  api.updateAiSettings.mockResolvedValue({});
  api.updateControlSettings.mockResolvedValue({ enabled: false });
  render(<WenzeQuestionsTab />);
  expect(await screen.findByText(/What Wenze learned from you/)).toBeTruthy();
  expect(await screen.findByText(/Answering Wenze in Telegram/)).toBeTruthy();

  // The learning switch is the AI settings' own field, read by this section itself.
  fireEvent.click(screen.getByRole("checkbox", { name: /Ask me when unsure/ }));
  await waitFor(() => expect(api.updateAiSettings).toHaveBeenCalledWith({ learningEnabled: false }));
  await waitFor(() => expect(screen.getByText("Saved.")).toBeTruthy());

  fireEvent.click(screen.getByRole("checkbox", { name: /Ask questions in Telegram/ }));
  await waitFor(() => expect(api.updateControlSettings).toHaveBeenCalled());
});

test("Provider Terms reads the provider list it needs by itself", async () => {
  render(<ProviderTermsTab />);
  expect(await screen.findByText(/Provider terms watcher/)).toBeTruthy();
  expect(api.getAiSettings).toHaveBeenCalled();
});

test("a section whose first read fails offers Retry instead of spinning, and Retry loads it", async () => {
  api.getAiSettings.mockRejectedValueOnce(new Error("Server unreachable"));
  render(<ProviderTermsTab />);
  const retry = await screen.findByRole("button", { name: "Retry" });
  expect(screen.getByText("Server unreachable")).toBeTruthy();
  expect(screen.queryByText(/Loading AI settings/)).toBeNull();

  fireEvent.click(retry);
  await waitFor(() => expect(api.getAiPolicyWatcher).toHaveBeenCalled());
  expect(api.getAiSettings).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  expect(screen.queryByText("Server unreachable")).toBeNull();
});
