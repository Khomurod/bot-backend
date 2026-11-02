/**
 * Messages → Scheduled on a phone (November 2026, docs/redesign/density.md
 * E2): the table carries wz-card-table, so below 640 px each scheduled
 * message is a card, and every cell names its own column, because the header
 * row is hidden there. A cell without a label would be an unlabelled value.
 */
import React from "react";
import { expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import * as api from "../../api";
import ScheduledTab from "./ScheduledTab";

vi.mock("../../api", () => ({
  getScheduledMessages: vi.fn(),
  cancelScheduledMessage: vi.fn(),
  sendScheduledMessageNow: vi.fn(),
}));

test("each scheduled message is a card on a phone, and every cell says which column it is", async () => {
  api.getScheduledMessages.mockResolvedValue([{
    id: 7, message_text_en: "Fuel card update", target_type: "all", status: "pending",
    scheduled_for: "2026-11-03T15:00:00Z", languages: ["en"],
  }]);
  render(<ScheduledTab />);
  const cell = await screen.findByText(/Fuel card update/);
  const table = cell.closest("table");
  expect(table.classList.contains("wz-card-table")).toBe(true);
  const headers = [...table.querySelectorAll("thead th")].map((th) => th.textContent.trim());
  const labels = [...table.querySelectorAll("tbody tr:first-child td")].map((td) => td.getAttribute("data-label"));
  expect(labels).toEqual(headers);
});
