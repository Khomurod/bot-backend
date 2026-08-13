/**
 * The timer launch button on the public presentation pages: it exists on BOTH
 * /answers (real) and /answers/test, it opens the full-screen timer, the TEST
 * page keeps its TEST marking inside the timer, and closing removes the overlay
 * without leaving a timer running.
 *
 * The summary API is mocked, so this asserts the page wiring only — no SOS data
 * is read or written by the timer.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import SosAnswersPage from "./SosAnswersPage";
import { getSosSummary } from "../../api/sos";

vi.mock("../../api/sos", () => ({
  getSosSummary: vi.fn(),
  clearSosTestData: vi.fn(),
  sosAdminLogin: vi.fn(),
}));

const SUMMARY = {
  open: true,
  total: 0,
  presentation: {
    subtitle: "Jamoaviy natijalar",
    centralQuestion: "Men nima qila olaman?",
    centralQuestionIntro: "Bitta savol:",
    techniques: [],
    practices: [],
  },
  patternMeta: {},
  company: { primaryPatterns: [], topPatterns: [] },
};

async function renderPage(isTest) {
  getSosSummary.mockResolvedValue(SUMMARY);
  render(<SosAnswersPage isTest={isTest} />);
  await waitFor(() => expect(screen.getByRole("button", { name: /10 daqiqalik taymer/ })).toBeInTheDocument());
}

const launch = () => screen.getByRole("button", { name: /10 daqiqalik taymer/ });

beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe.each([
  ["/answers", false],
  ["/answers/test", true],
])("%s", (_label, isTest) => {
  test("offers the Uzbek 10-minute timer button", async () => {
    await renderPage(isTest);
    expect(launch()).toBeInTheDocument();
  });

  test("the button opens a full-screen countdown starting at 10:00", async () => {
    await renderPage(isTest);
    fireEvent.click(launch());
    expect(screen.getByTestId("sos-timer")).toBeInTheDocument();
    expect(screen.getByTestId("sos-timer-clock").textContent).toBe("10:00");
  });

  test("exiting removes the overlay and leaves nothing ticking", async () => {
    await renderPage(isTest);
    fireEvent.click(launch());
    fireEvent.click(screen.getByRole("button", { name: /Chiqish/ }));
    await waitFor(() => expect(screen.queryByTestId("sos-timer")).toBeNull());
    expect(launch()).toBeInTheDocument(); // and it can be opened again
  });
});

describe("TEST presentation", () => {
  test("keeps the TEST marking inside the running timer", async () => {
    await renderPage(true);
    fireEvent.click(launch());
    expect(screen.getByTestId("sos-timer-test-badge").textContent).toMatch(/TEST/);
    act(() => { vi.advanceTimersByTime(35_000); });
    expect(screen.getByTestId("sos-timer").dataset.phase).toBe("message");
    expect(screen.getByTestId("sos-timer-test-badge")).toBeInTheDocument();
  });

  test("the real presentation timer carries no TEST marking", async () => {
    await renderPage(false);
    fireEvent.click(launch());
    expect(screen.queryByTestId("sos-timer-test-badge")).toBeNull();
  });

  test("only /answers/test exposes the cleanup control", async () => {
    await renderPage(false);
    expect(screen.queryByRole("button", { name: /Tozalash boʻlimini ochish/ })).toBeNull();
  });
});
