/**
 * Teaching Wenze, and the screen's one safety property: you cannot do it in one
 * motion.
 *
 * A candidate quoted a wrong pay rate is a real problem for a real person, so
 * typing a sentence produces a PROPOSAL and Wenze's reading of it, and a second
 * deliberate click is what puts it into use.
 */
import React from "react";
import { beforeEach, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import TeachWenzeCard from "./TeachWenzeCard";
import * as api from "../../api";

vi.mock("../../api", () => ({
  getRecruitingKnowledge: vi.fn(),
  teachWenze: vi.fn(),
  confirmRecruitingKnowledge: vi.fn(),
  rejectRecruitingKnowledge: vi.fn(),
  retireRecruitingKnowledge: vi.fn(),
}));

const ACTIVE = {
  id: 1, kind: "fact", topic: "pay", status: "active",
  statement: "Company driver pay is 70 CPM.",
  understoodAs: "Wenze may tell candidates the rate is 70 cents per mile.",
  confirmedBy: "boss",
};
const WAITING = {
  id: 2, kind: "fact", topic: "pay", status: "proposed",
  statement: "Starting today, company driver pay is 77 CPM instead of 70 CPM.",
  understoodAs: "Wenze will tell candidates the rate is 77 cents per mile.",
};
const OLD = {
  id: 0, kind: "fact", topic: "pay", status: "superseded",
  statement: "Company driver pay is 65 CPM.",
};

const flash = vi.fn();

async function open(entries = [ACTIVE]) {
  api.getRecruitingKnowledge.mockResolvedValue({ entries, summary: {} });
  render(<TeachWenzeCard flash={flash} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Tell Wenze" })).toBeInTheDocument());
}

beforeEach(() => { vi.clearAllMocks(); });

test("typing a sentence proposes it and shows what Wenze understood — it does NOT apply it", async () => {
  await open();
  api.teachWenze.mockResolvedValue({
    understoodAs: "Wenze will tell candidates the rate is 77 cents per mile.",
    replaces: ACTIVE,
    applied: false,
  });

  fireEvent.change(screen.getByPlaceholderText(/77 CPM instead of 70 CPM/), {
    target: { value: "Starting today, company driver pay is 77 CPM instead of 70 CPM." },
  });
  fireEvent.click(screen.getByRole("button", { name: "Tell Wenze" }));

  await waitFor(() => expect(screen.getByText(/Wenze understood:/)).toBeInTheDocument());
  expect(screen.getByText(/Nothing has changed yet/)).toBeInTheDocument();
  expect(api.confirmRecruitingKnowledge).not.toHaveBeenCalled();
});

test("the proposal names what it would replace, so nothing vanishes silently", async () => {
  await open();
  api.teachWenze.mockResolvedValue({
    understoodAs: "The rate is now 77 cents.", replaces: ACTIVE, applied: false,
  });
  fireEvent.change(screen.getByPlaceholderText(/77 CPM/), { target: { value: "Pay is 77 CPM now." } });
  fireEvent.click(screen.getByRole("button", { name: "Tell Wenze" }));
  await waitFor(() => expect(screen.getByText(/This would replace:/)).toBeInTheDocument());
  // Scoped to the banner: the same sentence also appears below under "In use",
  // and finding it there would prove nothing about the confirmation prompt.
  const banner = screen.getByText(/This would replace:/).closest("div");
  expect(banner.textContent).toContain("Company driver pay is 70 CPM.");
});

test("confirming is a separate, deliberate click", async () => {
  await open([WAITING, ACTIVE]);
  api.confirmRecruitingKnowledge.mockResolvedValue({ ...WAITING, status: "active" });
  fireEvent.click(screen.getByText("Yes, use this"));
  await waitFor(() => expect(api.confirmRecruitingKnowledge).toHaveBeenCalledWith(2));
});

test("turning a proposal down records why", async () => {
  await open([WAITING]);
  api.rejectRecruitingKnowledge.mockResolvedValue({ ...WAITING, status: "rejected" });
  fireEvent.change(screen.getByPlaceholderText("why not?"), { target: { value: "not until the first" } });
  fireEvent.click(screen.getByText("No"));
  await waitFor(() => expect(api.rejectRecruitingKnowledge).toHaveBeenCalledWith(2, "not until the first"));
});

test("what is waiting for a person is separated from what is in use", async () => {
  await open([WAITING, ACTIVE]);
  expect(screen.getByText(/Waiting for you \(1\)/)).toBeInTheDocument();
  expect(screen.getByText(/In use \(1\)/)).toBeInTheDocument();
});

test("an active fact can be taken out of use, and the button says it is kept", async () => {
  await open([ACTIVE]);
  const button = screen.getByText("Stop using");
  expect(button.getAttribute("title")).toMatch(/kept, not deleted/);
  api.retireRecruitingKnowledge.mockResolvedValue({ ...ACTIVE, status: "retired" });
  fireEvent.click(button);
  await waitFor(() => expect(api.retireRecruitingKnowledge).toHaveBeenCalledWith(1));
});

test("what is no longer used is still there to read", async () => {
  await open([ACTIVE, OLD]);
  expect(screen.getByText(/No longer used \(1\)/)).toBeInTheDocument();
  // "What were we telling candidates in August" is asked after a dispute.
  expect(screen.getByText("Company driver pay is 65 CPM.")).toBeInTheDocument();
});

test("knowing nothing says so plainly rather than showing an empty box", async () => {
  await open([]);
  expect(screen.getByText(/only use the standard message until you teach it something/))
    .toBeInTheDocument();
});
