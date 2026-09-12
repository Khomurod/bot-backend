/**
 * Past broadcasts — loaded when somebody is looking at them, and not before.
 *
 * WHY THIS IS WORTH A TEST. Send Message mounts BOTH composers (so a draft in
 * one survives switching to the other) but shows one. With an unconditional
 * load on mount that was two history requests on every visit, one of them
 * rendered nowhere — and because Send Message is the tab Communications opens
 * on, every visit paid for it whichever tab the person actually came for. This
 * application shows a banner at 80% of its monthly database transfer allowance;
 * a request nobody reads is not free.
 */
import React from "react";
import { describe, expect, test, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import * as api from "../../../api";
import { useBroadcastHistory } from "./useBroadcastHistory";

vi.mock("../../../api", () => ({
  getBroadcastHistory: vi.fn().mockResolvedValue([]),
  getBroadcastDeliveries: vi.fn().mockResolvedValue([]),
  getConfirmationClicks: vi.fn().mockResolvedValue([]),
}));

function Probe({ kind, enabled }) {
  useBroadcastHistory(kind, enabled);
  return null;
}

beforeEach(() => vi.clearAllMocks());

test("a hidden composer's history is not fetched", async () => {
  render(<Probe kind="confirmation" enabled={false} />);
  await waitFor(() => expect(api.getBroadcastHistory).not.toHaveBeenCalled());
});

test("a shown composer's history is fetched once", async () => {
  render(<Probe kind="regular" enabled />);
  await waitFor(() => expect(api.getBroadcastHistory).toHaveBeenCalledWith("regular"));
  expect(api.getBroadcastHistory).toHaveBeenCalledTimes(1);
});

test("it loads on the switch that first shows it, and not again on the next", async () => {
  const { rerender } = render(<Probe kind="confirmation" enabled={false} />);
  expect(api.getBroadcastHistory).not.toHaveBeenCalled();

  rerender(<Probe kind="confirmation" enabled />);
  await waitFor(() => expect(api.getBroadcastHistory).toHaveBeenCalledTimes(1));

  // Away and back costs nothing: the list is already there.
  rerender(<Probe kind="confirmation" enabled={false} />);
  rerender(<Probe kind="confirmation" enabled />);
  await waitFor(() => expect(api.getBroadcastHistory).toHaveBeenCalledTimes(1));
});

test("enabled defaults to true, so a caller that does not care still loads", async () => {
  render(<Probe kind="regular" />);
  await waitFor(() => expect(api.getBroadcastHistory).toHaveBeenCalledTimes(1));
});
