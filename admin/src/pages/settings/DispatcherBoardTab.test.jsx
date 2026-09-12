/**
 * Settings → Dispatcher Board.
 *
 * The Board authenticates by a token in its query string, so the properties
 * worth pinning on the screen are about what the screen does NOT do: it never
 * shows the token, it clears it out of the form the moment it is saved, and the
 * Test result it renders is counts — not the fleet's names and phone numbers.
 */
import React from "react";
import { expect, test, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import DispatcherBoardTab from "./DispatcherBoardTab";
import {
  getDispatchBoardSettings,
  updateDispatchBoardSettings,
  testDispatchBoardConnection,
  getDispatchBoardFeed,
} from "../../api";

vi.mock("../../api", () => ({
  getDispatchBoardSettings: vi.fn(),
  updateDispatchBoardSettings: vi.fn(),
  testDispatchBoardConnection: vi.fn(),
  getDispatchBoardFeed: vi.fn(),
}));

const BASE = "https://script.example.com/macros/s/AKfycbX/exec";
const TOKEN = "Sh4red-T0ken";

function stored(overrides = {}) {
  return {
    enabled: false,
    baseUrl: BASE,
    tokenSet: true,
    tokenMasked: "••••0ken",
    configured: true,
    pollIntervalSeconds: 300,
    lastPollAt: null,
    ...overrides,
  };
}

/** What the poller last stored — counts only, never a row. */
function feed(overrides = {}) {
  return {
    summary: {
      total: 0, present: 0,
      fleet: { company: 0, lease: 0, owner_operator: 0, unknown: 0 },
      teams: 0, linked: 0, statuses: [],
    },
    lastPollAt: null,
    lastPollOk: null,
    lastPollCount: null,
    lastError: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getDispatchBoardSettings.mockResolvedValue(stored());
  updateDispatchBoardSettings.mockResolvedValue(stored());
  testDispatchBoardConnection.mockResolvedValue({ connected: true, message: "Read 3 row(s) from the board." });
  getDispatchBoardFeed.mockResolvedValue(feed());
});

async function open() {
  render(<DispatcherBoardTab />);
  await waitFor(() => expect(screen.getByText(/Dispatcher Board/)).toBeInTheDocument());
}

test("the stored token is shown only as a mask", async () => {
  await open();
  expect(screen.getByText("••••0ken")).toBeInTheDocument();
  expect(screen.queryByDisplayValue(TOKEN)).not.toBeInTheDocument();
});

test("the board is off until somebody switches it on", async () => {
  await open();
  expect(screen.getByLabelText(/Read the board automatically/)).not.toBeChecked();
});

test("a token typed into the form is sent once and then cleared", async () => {
  await open();
  const field = screen.getByLabelText(/Board access token/);
  fireEvent.change(field, { target: { value: TOKEN } });
  fireEvent.click(screen.getByText("Save"));

  await waitFor(() => expect(updateDispatchBoardSettings).toHaveBeenCalled());
  expect(updateDispatchBoardSettings.mock.calls[0][0].token).toBe(TOKEN);
  // It must not linger in the form after it has been saved.
  await waitFor(() => expect(field).toHaveValue(""));
});

test("saving without touching the token does not send an empty one", async () => {
  await open();
  fireEvent.click(screen.getByText("Save"));
  await waitFor(() => expect(updateDispatchBoardSettings).toHaveBeenCalled());
  expect(updateDispatchBoardSettings.mock.calls[0][0]).not.toHaveProperty("token");
});

test("Test proves the candidate in the form, before it is saved", async () => {
  await open();
  fireEvent.change(screen.getByLabelText(/Board access token/), { target: { value: TOKEN } });
  fireEvent.click(screen.getByText("Test connection"));
  await waitFor(() => expect(testDispatchBoardConnection).toHaveBeenCalled());
  expect(testDispatchBoardConnection.mock.calls[0][0].token).toBe(TOKEN);
  expect(updateDispatchBoardSettings).not.toHaveBeenCalled();
});

test("a successful test renders counts, and the fleet counts it was given", async () => {
  testDispatchBoardConnection.mockResolvedValue({
    connected: true,
    message: "Read 102 row(s) from the board.",
    boardDate: "2026-09-12",
    count: 102,
    fleet: { company: 50, lease: 2, owner_operator: 50, unknown: 0 },
    status: { HOME: 17, DISPATCHED: 60 },
    teams: 11,
    normalisedLabels: 1,
    unknownFields: [],
  });
  await open();
  fireEvent.click(screen.getByText("Test connection"));
  await waitFor(() => expect(screen.getByText(/Read 102 row/)).toBeInTheDocument());
  expect(screen.getByText("Company drivers").nextSibling).toHaveTextContent("50");
  expect(screen.getByText("Team rows").nextSibling).toHaveTextContent("11");
  expect(screen.getByText(/Misspelled labels accepted/)).toBeInTheDocument();
  expect(screen.getByText(/HOME 17/)).toBeInTheDocument();
});

test("a column Wenze does not read yet is named, so the shape can be learned", async () => {
  testDispatchBoardConnection.mockResolvedValue({
    connected: true, message: "Read 1 row(s) from the board.",
    count: 1, fleet: {}, status: {}, teams: 0, unknownFields: ["mystery_column"],
  });
  await open();
  fireEvent.click(screen.getByText("Test connection"));
  await waitFor(() => expect(screen.getByText(/mystery_column/)).toBeInTheDocument());
});

test("a failed test shows the reason instead of pretending it worked", async () => {
  testDispatchBoardConnection.mockResolvedValue({ connected: false, message: "the board answered 401" });
  await open();
  fireEvent.click(screen.getByText("Test connection"));
  await waitFor(() => expect(screen.getByText("the board answered 401")).toBeInTheDocument());
});

test("the feed shows the last read once there has been one", async () => {
  getDispatchBoardFeed.mockResolvedValue(feed({
    lastPollAt: "2026-09-12T00:00:00.000Z",
    lastPollOk: true,
    lastPollCount: 102,
    summary: {
      total: 105, present: 102,
      fleet: { company: 50, lease: 2, owner_operator: 50, unknown: 0 },
      teams: 11, linked: 0,
      statuses: [{ status: "DISPATCHED", count: 60 }, { status: "HOME", count: 17 }],
    },
  }));
  await open();
  await waitFor(() => expect(screen.getByText("Last read")).toBeInTheDocument());
  expect(screen.getByText("Rows on the board now").nextSibling).toHaveTextContent("102");
  expect(screen.getByText(/DISPATCHED 60/)).toBeInTheDocument();
});

test("a board that has never been read says so, rather than showing zeros as a result", async () => {
  await open();
  await waitFor(() => expect(screen.getByText(/has not been read yet/)).toBeInTheDocument());
  expect(screen.queryByText("Last read")).not.toBeInTheDocument();
});

test("the feed shows counts, never a driver, a truck or a phone number", async () => {
  getDispatchBoardFeed.mockResolvedValue(feed({
    lastPollAt: "2026-09-12T00:00:00.000Z", lastPollOk: true,
    summary: {
      total: 1, present: 1,
      fleet: { company: 1, lease: 0, owner_operator: 0, unknown: 0 },
      teams: 0, linked: 0, statuses: [{ status: "HOME", count: 1 }],
    },
  }));
  await open();
  await waitFor(() => expect(screen.getByText("Last read")).toBeInTheDocument());
  const text = document.body.textContent;
  for (const secret of ["JOHN SMITH", "5555550001", "T-118"]) {
    expect(text).not.toContain(secret);
  }
});

test("a feed that cannot be read says so instead of rendering an empty board", async () => {
  getDispatchBoardFeed.mockRejectedValue(new Error("Failed to read the Dispatcher Board feed"));
  await open();
  await waitFor(() => expect(
    screen.getByText("Failed to read the Dispatcher Board feed")
  ).toBeInTheDocument());
  expect(screen.queryByText("Rows on the board now")).not.toBeInTheDocument();
});
