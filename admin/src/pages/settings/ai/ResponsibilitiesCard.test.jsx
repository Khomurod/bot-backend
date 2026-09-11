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

const flash = vi.fn();

async function open(automationError = null) {
  api.getAiResponsibilities.mockResolvedValue({ groups: GROUPS, automationError });
  render(<ResponsibilitiesCard flash={flash} />);
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
  // AiTab defines flash(type, text). Passing the message first renders an empty
  // alert with the message embedded in its CSS class — visible only to whoever
  // opens the inspector.
  expect(flash).toHaveBeenCalledWith("success", expect.stringContaining("AI analysis off"));
});

test("a save that fails reports as an error, with the message in the message slot", async () => {
  await open();
  api.updateAiCapability.mockRejectedValue(new Error("write failed"));
  fireEvent.click(screen.getAllByLabelText(/AI analysis/)[0]);
  await waitFor(() => expect(flash).toHaveBeenCalledWith("error", "write failed"));
});

test("an automation setting that could not be read shows as unknown, not as off", async () => {
  const unreadable = [{
    ...GROUPS[0],
    capabilities: [
      { ...GROUPS[0].capabilities[0],
        automation: { checkKey: "home_time.returned_to_road", known: false, enabled: null, maxPerRun: null } },
      GROUPS[0].capabilities[1],
    ],
  }];
  api.getAiResponsibilities.mockResolvedValue({ groups: unreadable, automationError: "connection refused" });
  render(<ResponsibilitiesCard flash={flash} />);
  await waitFor(() => expect(screen.getByText(/setting unknown, could not be read/)).toBeInTheDocument());
  // And the switch cannot be used to write a value nobody knows the current state of.
  expect(screen.getByLabelText(/Make the change automatically/)).toBeDisabled();
  expect(screen.getByText(/Wenze may still be applying corrections/)).toBeInTheDocument();
});

test("the automatic change is its own switch, and writes the check settings", async () => {
  await open();
  vi.clearAllMocks();
  api.getAiResponsibilities.mockResolvedValue({ groups: GROUPS, automationError: null });
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
