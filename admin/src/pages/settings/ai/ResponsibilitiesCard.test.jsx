/**
 * AI Responsibilities — the screen that answers "what is Wenze allowed to
 * decide on its own, and how do I stop it?"
 *
 * The two switches are deliberately separate and are asserted separately. AI
 * ANALYSIS decides whether a model is asked at all; AUTOMATIC CHANGE decides
 * whether a confident answer is acted on without a person. "Analysis on,
 * automatic changes off" is a legitimate way to run a fleet, and it is only
 * legitimate if turning one off leaves the other alone.
 */
import React from "react";
import { beforeEach, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import ResponsibilitiesCard from "./ResponsibilitiesCard";
import * as api from "../../../api";

vi.mock("../../../api", () => ({
  getAiResponsibilities: vi.fn(),
  updateAiCapability: vi.fn(),
  updateOperationsCheck: vi.fn(),
}));

const GROUPS = [
  {
    group: "Home Time",
    capabilities: [
      {
        key: "home_time_return_to_road",
        label: "Is the driver back on the road?",
        what: "Reads truck movement and load status to tell when a home stay ended.",
        changesState: true,
        stateNote: "Can move a driver from Home to Road and close their home stay.",
        mediumNote: "Anything short of confident becomes a Needs Attention item instead.",
        sendsRawText: false,
        fallback: "The scored evidence decides on its own; nothing stops working.",
        aiEnabled: true,
        registered: true,
        automation: { checkKey: "home_time.returned_to_road", enabled: true, maxPerRun: 25 },
      },
      {
        key: "home_time_reply",
        label: "Home time replies",
        what: "Writes the reply a driver reads.",
        changesState: false,
        stateNote: null,
        mediumNote: null,
        sendsRawText: true,
        fallback: "A fixed sentence.",
        aiEnabled: true,
        registered: true,
        automation: null,
      },
    ],
  },
];

async function open() {
  api.getAiResponsibilities.mockResolvedValue(GROUPS);
  render(<ResponsibilitiesCard flash={vi.fn()} />);
  await waitFor(() => expect(screen.getByText(/Is the driver back on the road\?/)).toBeInTheDocument());
}

beforeEach(() => { vi.clearAllMocks(); });

test("a responsibility that can change a record says so, in words", async () => {
  await open();
  expect(screen.getByText("can change information")).toBeInTheDocument();
  expect(screen.getByText(/Can move a driver from Home to Road/)).toBeInTheDocument();
  // And the one that only writes words is labelled for the privacy trade-off,
  // not for a power it does not have.
  expect(screen.getByText("sends message text")).toBeInTheDocument();
});

test("every responsibility says what happens with AI switched off", async () => {
  await open();
  expect(screen.getByText(/The scored evidence decides on its own/)).toBeInTheDocument();
  expect(screen.getByText(/A fixed sentence\./)).toBeInTheDocument();
});

test("turning AI analysis off touches the capability, never the automation", async () => {
  await open();
  api.updateAiCapability.mockResolvedValue({});
  fireEvent.click(screen.getAllByLabelText(/AI analysis/)[0]);
  await waitFor(() => expect(api.updateAiCapability).toHaveBeenCalledWith(
    "home_time_return_to_road", { aiEnabled: false }
  ));
  expect(api.updateOperationsCheck).not.toHaveBeenCalled();
});

test("the automatic change is its own switch, and writes the check settings", async () => {
  await open();
  api.updateOperationsCheck.mockResolvedValue({});
  fireEvent.click(screen.getByLabelText(/Make the change automatically/));
  await waitFor(() => expect(api.updateOperationsCheck).toHaveBeenCalledWith(
    "home_time.returned_to_road", { autoApplyEnabled: false, maxAutoPerRun: 25 }
  ));
  // The per-run cap is carried through rather than reset — switching automation
  // off and on again must not silently widen how much one pass may change.
  expect(api.updateAiCapability).not.toHaveBeenCalled();
});

test("a responsibility that changes nothing has no automation switch at all", async () => {
  await open();
  expect(screen.getAllByLabelText(/Make the change automatically/)).toHaveLength(1);
});
