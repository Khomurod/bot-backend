/**
 * Customer Inquiries → Auto-Reply, re-laid out in November 2026
 * (docs/redesign/density.md D1): the editor in the order the messages give way
 * to each other — basics, greeting schedule, fallback, then the per-recruiter
 * messages that beat them — with Save always in view, and a column kept in
 * view with the placeholder chips and both previews.
 */
import React from "react";
import { expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { AutoMessagesTab } from "./AutoMessagesTab";

const props = {
  settings: { is_enabled: true, timezone: "America/Chicago", fallback_template: "Hi" },
  setSettings: vi.fn(),
  rules: [{ label: "Daytime", days_of_week: [1], start_time_local: "08:00", end_time_local: "17:00", message_template: "Hello" }],
  setRules: vi.fn(),
  placeholders: [{ key: "first_name", description: "Lead's first name" }],
  previewTarget: { kind: "rule", index: 0 },
  nowPreview: { message: "Hello now" },
  editPreview: { message: "Hello edit" },
  nowSubtitle: "now", editingLabel: "Daytime",
  sampleLead: { full_name: "", phone_number: "", email: "" }, setSampleLead: vi.fn(),
  timezone: "America/Chicago",
  focusRule: vi.fn(), focusFallback: vi.fn(), insertPlaceholder: vi.fn(),
  fallbackRef: { current: null }, ruleRefs: { current: [] },
  recruiterMessages: [], setRecruiterTemplate: vi.fn(), focusRecruiter: vi.fn(), recruiterRefs: { current: {} },
  saving: false, handleSave: vi.fn(), handleReset: vi.fn(), toggleDay: vi.fn(), moveRule: vi.fn(),
};

test("the chips and both previews are in one column beside the editor", () => {
  const { container } = render(<AutoMessagesTab {...props} />);
  const aside = container.querySelector("aside");
  expect(aside.textContent).toMatch(/\{first_name\}/);
  expect(aside.textContent).toMatch(/Live Preview/);
  expect(aside.textContent).toMatch(/Editing Preview/);
});

test("greeting schedule, then fallback, then recruiter messages; Save stays in view", () => {
  render(<AutoMessagesTab {...props} />);
  const schedule = screen.getByRole("heading", { name: "Greeting schedule" });
  const fallback = screen.getByRole("heading", { name: /Fallback message/ });
  const recruiters = screen.getByRole("heading", { name: "Recruiter messages" });
  expect(schedule.compareDocumentPosition(fallback) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(fallback.compareDocumentPosition(recruiters) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.getByText(/Separate on purpose from the\s+working hours on Teach Wenze/)).toBeTruthy();
  const save = screen.getByRole("button", { name: "Save settings" });
  expect(save.parentElement.style.position).toBe("sticky");
});
