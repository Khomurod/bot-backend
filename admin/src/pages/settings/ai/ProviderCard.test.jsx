/**
 * Removing a provider: the only way to get a stored key out of Wenze. It asks
 * first, says the provider stops being used, and does nothing on Cancel.
 */
import React from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import ProviderCard from "./ProviderCard";
import * as api from "../../../api";

vi.mock("../../../api", () => ({
  updateAiProvider: vi.fn(),
  testAiProvider: vi.fn(),
  refreshAiProviderModels: vi.fn(),
  clearAiProviderCooldown: vi.fn(),
  deleteAiProvider: vi.fn(),
}));

const PROVIDER = {
  providerKey: "openrouter", label: "OpenRouter", adapter: "openai_chat", enabled: false,
  isFree: true, modelChain: ["model-a"], apiKeySet: true, apiKeyMasked: "••••abcd",
};

function renderCard() {
  const onSaved = vi.fn();
  const flash = vi.fn();
  render(<ProviderCard provider={PROVIDER} onSaved={onSaved} flash={flash} />);
  return { onSaved, flash };
}

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

test("Remove asks first, then deletes the provider and reloads the list", async () => {
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
  api.deleteAiProvider.mockResolvedValue({ deleted: true });
  const { onSaved, flash } = renderCard();

  fireEvent.click(screen.getByRole("button", { name: "Remove" }));

  expect(confirm.mock.calls[0][0]).toMatch(/Remove OpenRouter\? Wenze stops using this provider and its stored key is deleted/);
  await waitFor(() => expect(api.deleteAiProvider).toHaveBeenCalledWith("openrouter"));
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(flash).toHaveBeenCalledWith("success", "OpenRouter removed.");
});

test("Cancel removes nothing", () => {
  vi.spyOn(window, "confirm").mockReturnValue(false);
  const { onSaved } = renderCard();

  fireEvent.click(screen.getByRole("button", { name: "Remove" }));

  expect(api.deleteAiProvider).not.toHaveBeenCalled();
  expect(onSaved).not.toHaveBeenCalled();
});

test("a refused removal is shown, and the button can be pressed again", async () => {
  vi.spyOn(window, "confirm").mockReturnValue(true);
  api.deleteAiProvider.mockRejectedValue(new Error("No such provider"));
  const { flash, onSaved } = renderCard();

  fireEvent.click(screen.getByRole("button", { name: "Remove" }));

  await waitFor(() => expect(flash).toHaveBeenCalledWith("error", "No such provider"));
  expect(onSaved).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Remove" })).not.toBeDisabled();
});

test("while a removal is in flight, Save is disabled — a late save cannot bring the provider back", async () => {
  vi.spyOn(window, "confirm").mockReturnValue(true);
  let finish;
  api.deleteAiProvider.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  renderCard();

  fireEvent.click(screen.getByRole("button", { name: "Remove" }));

  await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeDisabled());
  expect(screen.getByRole("button", { name: "Removing…" })).toBeDisabled();
  finish({ deleted: true });
});
