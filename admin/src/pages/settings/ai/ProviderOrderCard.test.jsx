/**
 * Settings → AI → Order of providers. The first is the primary; the rest are
 * fallbacks in turn (owner, October 2026: "if I put Claude first, Claude is
 * used first"). Saving sends the WHOLE order at once.
 */
import React from "react";
import { afterEach, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import ProviderOrderCard from "./ProviderOrderCard";
import { setAiProviderOrder } from "../../../api";

vi.mock("../../../api", () => ({ setAiProviderOrder: vi.fn() }));

const PROVIDERS = [
  { providerKey: "groq", label: "Groq", enabled: true, isFree: true, modelChain: ["llama"] },
  { providerKey: "gemini", label: "Google Gemini", enabled: true, isFree: true, modelChain: ["flash"] },
  { providerKey: "anthropic", label: "Anthropic Claude", enabled: true, isFree: false, modelChain: ["claude-haiku-5-5"] },
];
const SETTINGS = { routingMode: "priority", freeOnlyMode: false };

afterEach(() => { vi.clearAllMocks(); });

function rows() {
  return screen.getAllByRole("listitem").map((li) => li.textContent);
}

test("moving Claude to the top makes it the primary and saves the whole order", async () => {
  setAiProviderOrder.mockResolvedValue({ ok: true });
  const onSaved = vi.fn();
  render(<ProviderOrderCard providers={PROVIDERS} settings={SETTINGS} onSaved={onSaved} flash={vi.fn()} />);

  expect(rows()[0]).toMatch(/Groq.*primary/);
  expect(screen.getByRole("button", { name: "Save order" })).toBeDisabled();

  fireEvent.click(screen.getByRole("button", { name: "Move Anthropic Claude up" }));
  fireEvent.click(screen.getByRole("button", { name: "Move Anthropic Claude up" }));

  expect(rows()[0]).toMatch(/Anthropic Claude.*primary/);
  expect(rows()[1]).toMatch(/Groq.*fallback 1/);
  expect(rows()[2]).toMatch(/Google Gemini.*fallback 2/);

  fireEvent.click(screen.getByRole("button", { name: "Save order" }));
  await waitFor(() => expect(setAiProviderOrder).toHaveBeenCalledWith(["anthropic", "groq", "gemini"]));
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
});

test("a paid provider under 'Free tiers only' and a switched-off one say they are not used", () => {
  const providers = [PROVIDERS[2], { ...PROVIDERS[0], enabled: false }, PROVIDERS[1]];
  render(<ProviderOrderCard providers={providers} settings={{ ...SETTINGS, freeOnlyMode: true }} onSaved={vi.fn()} flash={vi.fn()} />);
  const [claude, groq, gemini] = screen.getAllByRole("listitem");
  expect(within(claude).getByText(/skipped while/)).toBeInTheDocument();
  expect(claude.textContent).toMatch(/not used/);
  expect(groq.textContent).toMatch(/switched off/);
  expect(gemini.textContent).toMatch(/primary/);
});

test("rotate mode says the order is only a starting point", () => {
  render(<ProviderOrderCard providers={PROVIDERS} settings={{ ...SETTINGS, routingMode: "round_robin" }} onSaved={vi.fn()} flash={vi.fn()} />);
  expect(screen.getByText(/only a starting point/)).toBeInTheDocument();
});
