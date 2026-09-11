/**
 * The slot in the driver timeline that used to hold Approve / Do Not Approve.
 *
 * The buttons are gone from the admin panel, not merely hidden, and this is
 * what stops them coming back: a legacy `pending` row gets a sentence saying
 * nothing is waiting, and every other row gets nothing at all.
 */
import React from "react";
import { expect, test } from "vitest";
import { render, screen } from "@testing-library/react";
import RetiredApprovalNote from "./RetiredApprovalNote";

test("a legacy pending row says plainly that nothing is waiting for a decision", () => {
  render(<RetiredApprovalNote request={{ request_id: 7, status: "pending" }} />);
  expect(screen.getByText(/no longer approved or declined/i)).toBeInTheDocument();
  // A row reading "pending" with nothing beside it looks like a task. That is
  // the whole reason this renders a sentence instead of null.
  expect(screen.getByText(/Waiting for nobody/i)).toBeInTheDocument();
});

test("no button of any kind is rendered", () => {
  const { container } = render(<RetiredApprovalNote request={{ request_id: 7, status: "pending" }} />);
  expect(container.querySelectorAll("button")).toHaveLength(0);
  expect(container.textContent).not.toMatch(/Do Not Approve/);
});

test("a recorded request renders nothing — its status already says everything", () => {
  const { container } = render(<RetiredApprovalNote request={{ request_id: 7, status: "recorded" }} />);
  expect(container.textContent).toBe("");
});

test("a historical approved request is left entirely alone", () => {
  const { container } = render(<RetiredApprovalNote request={{ request_id: 7, status: "approved" }} />);
  expect(container.textContent).toBe("");
});

test("a row with no request id renders nothing", () => {
  const { container } = render(<RetiredApprovalNote request={{ status: "pending" }} />);
  expect(container.textContent).toBe("");
});
