/**
 * Monitoring → Logs: who changed what in Bitrix, and why.
 *
 * MUST SHOW: when, what (the deal, linked, and each field from → to), who
 * (the person and their Telegram id, or "Automatic" and the feature), why,
 * and the result with Bitrix's own words when it said no.
 *
 * MUST NOT: any button that changes anything — no retry, no revert.
 */
import React from "react";
import { beforeEach, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import LogsPage, { toQuery } from "./LogsPage";
import * as api from "../api";

vi.mock("../api", () => ({ getActivityLog: vi.fn() }));

const TRIGGERS = [
  { key: "board_bitrix.button", label: "Board ↔ Bitrix: a button under a question" },
  { key: "board_bitrix.sync", label: "Board ↔ Bitrix: the automatic status sync" },
];

const PRESSED = {
  id: 2, occurredAt: "2026-11-14T15:04:05.000Z", system: "bitrix", action: "deal.stage",
  targetType: "deal", targetId: "321", targetLabel: "Alan Brown", link: "https://acme.bitrix24.com/crm/deal/details/321/",
  change: [{ field: "STAGE_ID", from: "C9:W", to: "HOME (C9:H)" }],
  actorKind: "person_button", actorTelegramId: "777", actorName: "Dina Dispatcher", trigger: "board_bitrix.button",
  reason: "Pressed a button under a Board ↔ Bitrix question.", result: "done", error: null, attempt: null,
};
const REFUSED = {
  id: 1, occurredAt: "2026-11-14T15:00:00.000Z", system: "bitrix", action: "deal.stage",
  targetType: "deal", targetId: "400", targetLabel: null, link: null, change: [],
  actorKind: "automatic", actorTelegramId: null, actorName: null, trigger: "board_bitrix.sync",
  reason: "The Dispatcher Board says HOME.", result: "refused", error: "the deal stage changed after the comparison", attempt: 3,
};

beforeEach(() => {
  vi.clearAllMocks();
  api.getActivityLog.mockResolvedValue({ entries: [PRESSED, REFUSED], nextCursor: "c~1", triggers: TRIGGERS });
});

test("each line says when, what, who, why and how it ended", async () => {
  render(<LogsPage />);
  await waitFor(() => expect(screen.getByText("Dina Dispatcher")).toBeInTheDocument());
  expect(screen.getByRole("link", { name: "Deal 321" })).toHaveAttribute("href", "https://acme.bitrix24.com/crm/deal/details/321/");
  expect(screen.getByText("STAGE_ID: C9:W → HOME (C9:H)")).toBeInTheDocument();
  expect(screen.getByText(/Telegram 777/)).toBeInTheDocument();
  expect(screen.getByText("Automatic: Board ↔ Bitrix: the automatic status sync")).toBeInTheDocument();
  expect(screen.getByText("Refused", { selector: "span" })).toBeInTheDocument();
  expect(screen.getByText("the deal stage changed after the comparison")).toBeInTheDocument();
  expect(screen.getByText("Attempt 3")).toBeInTheDocument();
  expect(screen.getByText("Done", { selector: "span" })).toBeInTheDocument();
});

test("read-only: no retry, no revert", async () => {
  render(<LogsPage />);
  await waitFor(() => expect(screen.getByText("Dina Dispatcher")).toBeInTheDocument());
  const labels = screen.getAllByRole("button").map((b) => b.textContent);
  expect(labels.sort()).toEqual(["Apply", "Clear", "Refresh", "Show older"].sort());
});

test("filters reach the server, and Show older asks for the next page", async () => {
  render(<LogsPage />);
  await waitFor(() => expect(screen.getByText("Dina Dispatcher")).toBeInTheDocument());
  fireEvent.change(screen.getByLabelText("Result"), { target: { value: "refused" } });
  fireEvent.change(screen.getByLabelText("Feature"), { target: { value: "board_bitrix.sync" } });
  fireEvent.change(screen.getByLabelText("Deal number or name"), { target: { value: "400" } });
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  await waitFor(() => expect(api.getActivityLog).toHaveBeenCalledTimes(2));
  expect(api.getActivityLog.mock.calls[1][0]).toMatchObject({ result: "refused", trigger: "board_bitrix.sync", search: "400", before: null });

  await waitFor(() => expect(screen.getByRole("button", { name: "Show older" })).not.toBeDisabled());
  fireEvent.click(screen.getByRole("button", { name: "Show older" }));
  await waitFor(() => expect(api.getActivityLog).toHaveBeenCalledTimes(3));
  expect(api.getActivityLog.mock.calls[2][0]).toMatchObject({ before: "c~1", result: "refused" });
});

test("someone who is not a super administrator is told so", async () => {
  api.getActivityLog.mockRejectedValue(Object.assign(new Error("Only a super administrator may do this"), { status: 403 }));
  render(<LogsPage />);
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Only a super administrator can open the Logs."));
});

test("a 'to' date includes its whole day", () => {
  const q = toQuery({ from: "2026-11-01", to: "2026-11-01", trigger: "", result: "", search: "" });
  expect(new Date(q.to) - new Date(q.from)).toBe(24 * 3600 * 1000);
  expect(toQuery({ from: "", to: "" }).from).toBe("");
});
