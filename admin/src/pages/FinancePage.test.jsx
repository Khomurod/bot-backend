/**
 * The Finance page.
 *
 * ONE TAB THROWING MUST NOT TAKE THE OTHER THREE. The whole point of the page
 * is that somebody can get at the money codes; losing all four — and the tab
 * bar with them — because one table hit a bad row is exactly what a single
 * shared error boundary produces, and it is the failure this repository has
 * already shipped once elsewhere.
 *
 * AND THE WORDING IS PART OF THE FEATURE. "Could not fetch it" and "needs a
 * person" are different answers with different buttons, and a repeat is
 * described as a repeat and never as a payment.
 */
import React from "react";
import { expect, test, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import FinancePage from "./FinancePage";
import * as api from "../api";

vi.mock("../api", () => ({
  listFinanceMessages: vi.fn(),
  listFinanceMoneycodes: vi.fn(),
  listFinanceDocuments: vi.fn(),
  listFinanceReports: vi.fn(),
  reparseFinanceMessage: vi.fn(),
  retryFinanceDocument: vi.fn(),
  previewFinanceReport: vi.fn(),
  sendFinanceReportNow: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  api.listFinanceMoneycodes.mockResolvedValue({ moneycodes: [] });
  api.listFinanceMessages.mockResolvedValue({ messages: [] });
  api.listFinanceDocuments.mockResolvedValue({ documents: [] });
  api.listFinanceReports.mockResolvedValue({ reports: [] });
  api.previewFinanceReport.mockResolvedValue({
    periodStart: "2026-08-31T13:00:00Z", periodEnd: "2026-09-07T13:00:00Z",
    totals: { codeCount: 2, amountTotal: 400 }, body: "<b>Money codes</b>\n2 codes",
  });
  api.sendFinanceReportNow.mockResolvedValue({ sent: true, periodStart: "2026-08-31T13:00:00Z" });
});

test("it opens on the money codes", async () => {
  render(<FinancePage />);
  await waitFor(() => expect(api.listFinanceMoneycodes).toHaveBeenCalled());
  expect(api.listFinanceMessages).not.toHaveBeenCalled();
});

test("a repeat is described as a repeat, never as a payment", async () => {
  api.listFinanceMoneycodes.mockResolvedValue({
    moneycodes: [
      {
        id: 1, code: "1111 2222", amount: 500, currency: "USD", senderName: "A Poster",
        issuedAt: "2026-09-01T12:00:00Z", duplicateOfId: 9, duplicateReason: "same_code",
      },
      {
        id: 2, code: "3333 4444", amount: 500, currency: "USD", senderName: "A Poster",
        issuedAt: "2026-09-01T13:00:00Z", duplicateOfId: 9,
        duplicateReason: "same_amount_recipient_window",
      },
    ],
  });
  const { container } = render(<FinancePage />);

  expect(await screen.findByText(/this code was posted before/i)).toBeTruthy();
  // The suspicion says it is one.
  expect(screen.getByText(/often legitimate/i)).toBeTruthy();
  // The claim it must never make.
  expect(container.textContent).not.toMatch(/paid twice|double.?paid/i);
});

test("attachments: only the unfetchable ones offer a retry", async () => {
  api.listFinanceDocuments.mockResolvedValue({
    documents: [
      { id: 1, status: "needs_review", reviewReason: "low_confidence", fileName: "a.pdf", createdAt: "2026-09-01T00:00:00Z" },
    ],
  });
  render(<FinancePage />);
  fireEvent.click(screen.getByRole("button", { name: /Attachments/i }));

  expect(await screen.findByText(/not confident enough/i)).toBeTruthy();
  // Running the same reader over the same bytes reaches the same place, so a
  // retry here would be a button that does nothing and looks like it should.
  expect(screen.queryByRole("button", { name: /Try again/i })).toBeNull();

  api.listFinanceDocuments.mockResolvedValue({
    documents: [
      { id: 2, status: "failed", lastError: "Telegram answered 502", fileName: "b.pdf", createdAt: "2026-09-01T00:00:00Z" },
    ],
  });
  fireEvent.click(screen.getByRole("button", { name: /Could not be fetched/i }));
  expect(await screen.findByRole("button", { name: /Try again/i })).toBeTruthy();
});

test("messages open on the UNCLEAR pile, not on four thousand ordinary ones", async () => {
  render(<FinancePage />);
  fireEvent.click(screen.getByRole("button", { name: /💬 Messages/i }));
  await waitFor(() => expect(api.listFinanceMessages).toHaveBeenCalledWith("ambiguous"));
});

test("re-reading a message reports what changed, in words", async () => {
  api.listFinanceMessages.mockResolvedValue({
    messages: [{
      id: 7, chatId: "-100", messageId: 5, senderName: "A Poster",
      text: "money code 1111", parseStatus: "ambiguous",
      messageDate: "2026-09-01T00:00:00Z", telegramUrl: null,
    }],
  });
  api.reparseFinanceMessage.mockResolvedValue({ id: 7, before: "ambiguous", after: "parsed" });

  render(<FinancePage />);
  fireEvent.click(screen.getByRole("button", { name: /💬 Messages/i }));
  fireEvent.click(await screen.findByRole("button", { name: /Read it again/i }));

  await waitFor(() => expect(api.reparseFinanceMessage).toHaveBeenCalledWith(7));
  expect(await screen.findByText(/now "Read"/i)).toBeTruthy();
});

test("a week that was not sent says WHY, not just that it was not", async () => {
  api.listFinanceReports.mockResolvedValue({
    reports: [{
      id: 1, periodStart: "2026-08-31T13:00:00Z", status: "suppressed_backfill",
      totals: null, sentAt: null,
    }],
  });
  render(<FinancePage />);
  fireEvent.click(screen.getByRole("button", { name: /Weekly summaries/i }));
  expect(await screen.findByText(/we were not watching that week/i)).toBeTruthy();
});

test("a tab that cannot load says so, and the page carries on", async () => {
  api.listFinanceDocuments.mockRejectedValue(new Error("the documents table is on fire"));
  render(<FinancePage />);
  fireEvent.click(screen.getByRole("button", { name: /Attachments/i }));

  expect(await screen.findByText(/the documents table is on fire/i)).toBeTruthy();
  expect(screen.getByRole("button", { name: /Money codes/i })).toBeTruthy();
});

test("ONE TAB THROWING DURING RENDER DOES NOT TAKE THE PAGE", async () => {
  // Not a failed request — the tab handles that itself. This is the case a
  // shared error boundary swallows the whole section for: a bad row, a shape
  // nobody expected, an exception while rendering. The tab bar has to survive
  // it, because the whole point of the page is getting at the money codes.
  api.listFinanceDocuments.mockResolvedValue({ documents: "not an array at all" });
  render(<FinancePage />);
  fireEvent.click(screen.getByRole("button", { name: /Attachments/i }));

  await waitFor(() => expect(screen.getByRole("button", { name: /Money codes/i })).toBeTruthy());

  // And switching away recovers, because the boundary is keyed on the tab.
  fireEvent.click(screen.getByRole("button", { name: /Money codes/i }));
  await waitFor(() => expect(screen.getByText(/Nothing here yet/i)).toBeTruthy());
});

// ── preview and send now ──────────────────────────────────────────────────

test("a preview reaches no chat", async () => {
  render(<FinancePage />);
  fireEvent.click(screen.getByRole("button", { name: /Weekly summaries/i }));
  fireEvent.click(await screen.findByRole("button", { name: /Preview/i }));

  await waitFor(() => expect(api.previewFinanceReport).toHaveBeenCalled());
  expect(api.sendFinanceReportNow).not.toHaveBeenCalled();
});

/**
 * The markup is SHOWN, not rendered. The body is built from what people typed
 * in the finance group, and a page that interpreted it would be trusting the
 * far side of an API to have escaped it.
 */
test("the preview body is displayed as text, never as markup", async () => {
  api.previewFinanceReport.mockResolvedValue({
    periodStart: "2026-08-31T13:00:00Z", periodEnd: "2026-09-07T13:00:00Z",
    totals: {}, body: "<b>Money codes</b>",
  });
  const { container } = render(<FinancePage />);
  fireEvent.click(screen.getByRole("button", { name: /Weekly summaries/i }));
  fireEvent.click(await screen.findByRole("button", { name: /Preview/i }));

  expect(await screen.findByText("<b>Money codes</b>")).toBeTruthy();
  expect(container.querySelector("pre b")).toBeNull();
});

/** One click does not put a message in front of people. */
test("SENDING ASKS FIRST", async () => {
  render(<FinancePage />);
  fireEvent.click(screen.getByRole("button", { name: /Weekly summaries/i }));
  fireEvent.click(await screen.findByRole("button", { name: /Send it now/i }));

  expect(api.sendFinanceReportNow).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: /Yes — send it/i }));
  await waitFor(() => expect(api.sendFinanceReportNow).toHaveBeenCalled());
});

/** "No chat is set" is shown as the reason, not as a generic failure. */
test("a refusal to send names what is missing", async () => {
  api.sendFinanceReportNow.mockResolvedValue({ sent: false, error: "No chat is set for the finance report." });
  render(<FinancePage />);
  fireEvent.click(screen.getByRole("button", { name: /Weekly summaries/i }));
  fireEvent.click(await screen.findByRole("button", { name: /Send it now/i }));
  fireEvent.click(screen.getByRole("button", { name: /Yes — send it/i }));

  expect(await screen.findByText(/No chat is set/i)).toBeTruthy();
});
