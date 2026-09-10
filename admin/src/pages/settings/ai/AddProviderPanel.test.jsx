/**
 * Settings → AI → Add a provider: pick, paste, Connect — and nothing else.
 *
 * The load-bearing assertions are the ABSENCES: for a known provider there is
 * no Base URL field and no model list, because those are the fields this panel
 * exists to remove. The custom entry is the one place they appear.
 */
import React from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import AddProviderPanel from "./AddProviderPanel";
import { getAiCatalog, connectAiProvider } from "../../../api";

vi.mock("../../../api", () => ({
  getAiCatalog: vi.fn(),
  connectAiProvider: vi.fn(),
}));

const CATALOG = [
  { key: "groq", label: "Groq", adapter: "openai_chat", isFree: true, needsBaseUrl: false, configured: true, keyPrefix: "gsk_", docsUrl: "https://console.groq.com/docs" },
  { key: "openrouter", label: "OpenRouter", adapter: "openai_chat", isFree: true, needsBaseUrl: false, configured: false, keyPrefix: "sk-or-", freeTierNote: "Some models are free." },
  { key: "custom", label: "Custom OpenAI-compatible provider", adapter: "openai_chat", isFree: false, needsBaseUrl: true, configured: false, keyPrefix: null },
];

async function open() {
  getAiCatalog.mockResolvedValue(CATALOG);
  render(<AddProviderPanel onConnected={vi.fn()} />);
  await waitFor(() => expect(screen.getByRole("option", { name: /OpenRouter/ })).toBeInTheDocument());
}

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.clearAllMocks(); });

test("a known provider asks for the key and nothing technical", async () => {
  await open();
  fireEvent.click(screen.getByRole("option", { name: /OpenRouter/ }));

  expect(screen.getByLabelText(/OpenRouter API key/)).toBeInTheDocument();
  expect(screen.queryByLabelText(/Base URL/)).toBeNull();
  expect(screen.queryByLabelText(/Models/)).toBeNull();
  expect(screen.getByText(/Some models are free/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled();
});

test("Connect sends only the catalogue key and the pasted key, and shows the words that came back", async () => {
  connectAiProvider.mockResolvedValue({
    ok: true, providerKey: "openrouter", label: "OpenRouter",
    message: "OpenRouter connected successfully.\n14 compatible models found.\n6 free models currently available.\nWenze selected 3 preferred models for fallback.",
    report: { selected: ["a", "b", "c"] },
  });
  await open();
  fireEvent.click(screen.getByRole("option", { name: /OpenRouter/ }));
  fireEvent.change(screen.getByLabelText(/OpenRouter API key/), { target: { value: "sk-or-abc" } });
  fireEvent.click(screen.getByRole("button", { name: "Connect" }));

  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/OpenRouter connected successfully/));
  expect(connectAiProvider).toHaveBeenCalledWith({ catalogKey: "openrouter", apiKey: "sk-or-abc" });
  expect(screen.getByRole("status")).toHaveTextContent(/6 free models currently available/);
  expect(screen.getByText(/Fallback order: a → b → c/)).toBeInTheDocument();
});

test("a rejected key is shown as the reason, not as a crash", async () => {
  connectAiProvider.mockResolvedValue({ ok: false, reason: "invalid_key", message: "API key is invalid." });
  await open();
  fireEvent.click(screen.getByRole("option", { name: /OpenRouter/ }));
  fireEvent.change(screen.getByLabelText(/OpenRouter API key/), { target: { value: "wrong" } });
  fireEvent.click(screen.getByRole("button", { name: "Connect" }));

  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("API key is invalid."));
});

test("only the custom provider asks for a Base URL, and requires https", async () => {
  await open();
  fireEvent.click(screen.getByRole("option", { name: /Custom OpenAI-compatible/ }));

  const url = screen.getByLabelText(/API Base URL/);
  fireEvent.change(screen.getByLabelText(/API key/), { target: { value: "k" } });
  fireEvent.change(url, { target: { value: "http://insecure.example.com/v1" } });
  expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled();
  fireEvent.change(url, { target: { value: "https://llm.example.com/v1" } });
  expect(screen.getByRole("button", { name: "Connect" })).toBeEnabled();
});

test("an already-added provider is still offered, marked as added", async () => {
  await open();
  expect(screen.getByRole("option", { name: /Groq.*added/ })).toBeInTheDocument();
});
