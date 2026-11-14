/**
 * Settings → AI → "Providers for one task" (owner, 14 November 2026): the
 * owner picks which providers may read a CDL photo, and in what order. The
 * card saves exactly the list on screen, says plainly when nothing will be
 * read, and warns about a provider that would not be asked anyway.
 */
import React from "react";
import { beforeEach, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import CapabilityProvidersCard from "./CapabilityProvidersCard";
import * as api from "../../../api";

vi.mock("../../../api", () => ({
  getAiCapabilityProviders: vi.fn(),
  setAiCapabilityProviders: vi.fn(),
}));

const PROVIDERS = [
  { providerKey: "gemini", label: "Google Gemini", enabled: true, isFree: true, hasKey: true, canSee: true },
  { providerKey: "anthropic", label: "Anthropic Claude", enabled: true, isFree: false, hasKey: true, canSee: true },
  { providerKey: "cerebras", label: "Cerebras", enabled: true, isFree: true, hasKey: true, canSee: false },
];
const task = (order, over = {}) => ({
  key: "hiring_cdl_reading", label: "Read a candidate's CDL photo", providerChoice: "required",
  needsVision: true, aiEnabled: true, order, ...over,
});
const flash = vi.fn();

function open(order, { freeOnlyMode = false, extra = {} } = {}) {
  api.getAiCapabilityProviders.mockResolvedValue({ capabilities: [task(order, extra)], providers: PROVIDERS, freeOnlyMode });
  render(<CapabilityProvidersCard flash={flash} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  api.setAiCapabilityProviders.mockResolvedValue({ order: [] });
});

test("NO PROVIDER CHOSEN says plainly that nothing is read", async () => {
  open([]);
  expect(await screen.findByText(/No provider chosen — nothing is read/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Save providers" })).toBeDisabled();
  expect(screen.queryByText(/Use the order above again/), "a required choice cannot fall back").toBeNull();
});

test("choosing Gemini then Claude saves exactly that order", async () => {
  open([]);
  const select = await screen.findByLabelText(/Add a provider to Read a candidate's CDL photo/);
  fireEvent.change(select, { target: { value: "gemini" } });
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  fireEvent.change(screen.getByLabelText(/Add a provider to/), { target: { value: "anthropic" } });
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  const list = screen.getByRole("list", { name: /Providers for Read a candidate's CDL photo/ });
  expect(within(list).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
    expect.stringContaining("Google Gemini"), expect.stringContaining("Anthropic Claude"),
  ]);
  fireEvent.click(screen.getByRole("button", { name: "Save providers" }));
  await waitFor(() => expect(api.setAiCapabilityProviders).toHaveBeenCalledWith("hiring_cdl_reading", ["gemini", "anthropic"]));
  expect(flash).toHaveBeenCalledWith("success", expect.stringMatching(/providers saved/));
  expect(api.getAiCapabilityProviders).toHaveBeenCalledTimes(2);
});

test("the order can be changed and a provider removed — only Claude", async () => {
  open(["gemini", "anthropic"]);
  expect(await screen.findByText("Asked of: Google Gemini → Anthropic Claude")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Move Anthropic Claude up" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove Google Gemini" }));
  fireEvent.click(screen.getByRole("button", { name: "Save providers" }));
  await waitFor(() => expect(api.setAiCapabilityProviders).toHaveBeenCalledWith("hiring_cdl_reading", ["anthropic"]));
});

test("a provider that would not be asked anyway says why", async () => {
  open(["anthropic", "cerebras"], { freeOnlyMode: true });
  expect(await screen.findByText(/paid — skipped while “Free tiers only” is on/)).toBeTruthy();
  expect(screen.getByText(/none of its models can read a picture/)).toBeTruthy();
});

test("a task that may follow the global order can be handed back to it", async () => {
  open(["gemini"], { extra: { providerChoice: "optional", key: "translation", label: "Translate a broadcast", needsVision: false } });
  fireEvent.click(await screen.findByRole("button", { name: /Use the order above again/ }));
  await waitFor(() => expect(api.setAiCapabilityProviders).toHaveBeenCalledWith("translation", null));
});

test("a failed save is reported, not swallowed", async () => {
  api.setAiCapabilityProviders.mockRejectedValue(new Error("There is no provider \"x\"."));
  open(["gemini"]);
  fireEvent.click(await screen.findByRole("button", { name: "Remove Google Gemini" }));
  fireEvent.click(screen.getByRole("button", { name: "Save providers" }));
  await waitFor(() => expect(flash).toHaveBeenCalledWith("error", "There is no provider \"x\"."));
});
