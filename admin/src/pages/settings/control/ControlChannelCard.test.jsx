/**
 * The control channel card, and the one thing on it that must not go wrong.
 *
 * The allow-list is not a preference — it is what stands between a reply in a
 * Telegram group and a change to the fleet. So the screen says so when it is
 * empty, and it refuses to let the last person be removed.
 */
import React from "react";
import { beforeEach, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import ControlChannelCard from "./ControlChannelCard";
import * as api from "../../../api";

vi.mock("../../../api", () => ({
  getControlSettings: vi.fn(),
  updateControlSettings: vi.fn(),
  addControlOperator: vi.fn(),
  removeControlOperator: vi.fn(),
  forgetControlAnswer: vi.fn(),
}));

const STATE = {
  settings: { enabled: true, maxQuestionsPerPass: 5, repeatAfterHours: 72, clarifyLimit: 1 },
  operators: [
    { telegramUserId: "2117922421", label: "Owner", enabled: true },
    { telegramUserId: "555001", label: "Dispatcher", enabled: true },
  ],
  replies: { available: true, total: 4, refused: 1, last7d: 3 },
  knowledge: [
    {
      id: 12, checkKey: "board.truck_disagrees_with_profile",
      answerAction: "dismiss", answerText: "He swapped trucks this morning.",
      timesApplied: 3,
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  api.getControlSettings.mockResolvedValue(STATE);
  api.updateControlSettings.mockResolvedValue(STATE.settings);
  api.addControlOperator.mockResolvedValue({ telegramUserId: "555002" });
  api.removeControlOperator.mockResolvedValue({ telegramUserId: "555001" });
  api.forgetControlAnswer.mockResolvedValue({ id: 12 });
});

test("shows who Wenze obeys", async () => {
  render(<ControlChannelCard />);
  expect(await screen.findByText("Owner")).toBeTruthy();
  expect(screen.getByText("2117922421")).toBeTruthy();
  expect(screen.getByText("Dispatcher")).toBeTruthy();
});

test("AN EMPTY ALLOW-LIST SAYS SO OUT LOUD", async () => {
  api.getControlSettings.mockResolvedValue({ ...STATE, operators: [] });
  render(<ControlChannelCard />);
  expect(await screen.findByText(/Nobody is on the list/)).toBeTruthy();
});

test("THE LAST OPERATOR CANNOT BE REMOVED FROM THE SCREEN", async () => {
  api.getControlSettings.mockResolvedValue({
    ...STATE,
    operators: [{ telegramUserId: "2117922421", label: "Owner", enabled: true }],
  });
  render(<ControlChannelCard />);
  const remove = await screen.findByRole("button", { name: "Remove" });
  expect(remove.disabled).toBe(true);
});

test("removing one of several calls the API and reloads", async () => {
  render(<ControlChannelCard />);
  const buttons = await screen.findAllByRole("button", { name: "Remove" });
  fireEvent.click(buttons[1]);
  await waitFor(() => expect(api.removeControlOperator).toHaveBeenCalledWith("555001"));
});

test("adding takes a numeric id and says it is not a username", async () => {
  render(<ControlChannelCard />);
  const input = await screen.findByPlaceholderText(/Telegram user id/);
  fireEvent.change(input, { target: { value: "555002" } });
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  await waitFor(() => expect(api.addControlOperator).toHaveBeenCalledWith(
    expect.objectContaining({ telegramUserId: "555002" })
  ));
  expect(screen.getByText(/Not a username/)).toBeTruthy();
});

test("the switch saves immediately", async () => {
  render(<ControlChannelCard />);
  const toggle = await screen.findByRole("checkbox");
  fireEvent.click(toggle);
  await waitFor(() => expect(api.updateControlSettings).toHaveBeenCalledWith({ enabled: false }));
});

test("a failure to load says so rather than showing an empty list", async () => {
  api.getControlSettings.mockRejectedValue(new Error("Postgres is unreachable"));
  render(<ControlChannelCard />);
  expect(await screen.findByText(/Postgres is unreachable/)).toBeTruthy();
});

test("refused replies are counted where somebody will see them", async () => {
  render(<ControlChannelCard />);
  expect(await screen.findByText(/not on the list were ignored/)).toBeTruthy();
});

test("a remembered answer is shown in the owner's own words", async () => {
  render(<ControlChannelCard />);
  expect(await screen.findByText(/He swapped trucks this morning/)).toBeTruthy();
  // The count is what tells somebody the memory is doing anything at all.
  expect(screen.getByText("3")).toBeTruthy();
});

test("IT SAYS A MEMORY IS NOT THE CHECK BEING SWITCHED OFF", async () => {
  render(<ControlChannelCard />);
  // The whole safety rule, in the sentence a person actually reads: the answer
  // is attached to one situation, and a new problem is still raised.
  expect(await screen.findByText(/while that situation stays as it is/i)).toBeTruthy();
  expect(screen.getByText(/still asked about/i)).toBeTruthy();
});

test("forgetting an answer calls the server and reloads", async () => {
  render(<ControlChannelCard />);
  fireEvent.click(await screen.findByText("Forget"));
  await waitFor(() => expect(api.forgetControlAnswer).toHaveBeenCalledWith(12));
  await waitFor(() => expect(api.getControlSettings).toHaveBeenCalledTimes(2));
});

test("with nothing remembered it explains what would put something there", async () => {
  api.getControlSettings.mockResolvedValue({ ...STATE, knowledge: [] });
  render(<ControlChannelCard />);
  expect(await screen.findByText(/Nothing is being remembered yet/i)).toBeTruthy();
});
