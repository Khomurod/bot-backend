/**
 * Settings → Facebook ↔ Bitrix: Save stays disabled until a Test passed with
 * exactly the values in the form, and any edit locks it again. The token is
 * shown as its last four characters only, and the switch stops the sync
 * without touching the credentials.
 */
import React from "react";
import { beforeEach, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import MetaCrmTab from "./MetaCrmTab";
import { canSave, formFingerprint } from "./metaCrm/testGate";
import * as api from "../../api";

vi.mock("../../api", () => ({
  getMetaCrmSettings: vi.fn(),
  testMetaCrmSettings: vi.fn(),
  saveMetaCrmSettings: vi.fn(),
  setMetaCrmEnabled: vi.fn(),
}));

const TOKEN = "EAAG-component-test-token-000000";
const stored = {
  enabled: true, configured: true, datasetId: "111222", datasetSource: "environment",
  tokenSet: true, tokenLast4: "WXYZ", tokenMasked: "••••WXYZ", tokenSource: "environment", tokenUnreadable: false,
  updatedAt: null, updatedBy: null,
  lastRun: { finishedAt: "2026-10-27T15:00:00Z", status: "ok", sent: 4, failed: 0, recorded: 4, deals: 11, error: null },
};
const passed = {
  passed: true,
  usedStoredToken: false,
  checks: [
    { key: "token", label: "Token and dataset", status: "pass", message: "Meta accepts the token." },
    { key: "test_event", label: "Test event", status: "not_run", message: "Not run: no test event code was given." },
    { key: "bitrix", label: "Bitrix pipeline", status: "pass", message: "Bitrix is connected." },
    { key: "dry_run", label: "Dry run", status: "pass", message: "A pass now would send 2 Qualified.",
      detail: { examples: [{ dealId: 5603, stageId: "EXECUTING", eventName: "Qualified" }] } },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  api.getMetaCrmSettings.mockResolvedValue(stored);
});

const saveButton = () => screen.getByRole("button", { name: "Save" });

test("shows what is in effect: ON, the dataset and where it comes from, the token's last four only, the last run", async () => {
  render(<MetaCrmTab />);
  expect(await screen.findByText("Sync is ON")).toBeInTheDocument();
  expect(screen.getByText("111222")).toBeInTheDocument();
  expect(screen.getAllByText(/from the server's environment variable/).length).toBe(2);
  expect(screen.getByText("••••WXYZ")).toBeInTheDocument();
  expect(screen.getByText(/4 event\(s\) sent to Meta, 0 failed/)).toBeInTheDocument();
});

test("Save is disabled until a Test passes, and an edit after the Test locks it again", async () => {
  api.testMetaCrmSettings.mockResolvedValue(passed);
  render(<MetaCrmTab />);
  await screen.findByText("Sync is ON");
  expect(saveButton()).toBeDisabled();

  fireEvent.change(screen.getByLabelText("Access token"), { target: { value: TOKEN } });
  expect(saveButton()).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Test" }));
  await waitFor(() => expect(saveButton()).toBeEnabled());
  expect(api.testMetaCrmSettings).toHaveBeenCalledWith({ datasetId: "111222", token: TOKEN, testEventCode: "" });
  expect(screen.getByText("5603")).toBeInTheDocument();

  fireEvent.change(screen.getByLabelText("Dataset ID"), { target: { value: "111223" } });
  expect(saveButton()).toBeDisabled();
  expect(screen.getByText(/changed after the test/)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Dataset ID"), { target: { value: "111222" } });
  expect(saveButton()).toBeEnabled();
  fireEvent.change(screen.getByLabelText("Test event code (optional)"), { target: { value: "TEST1" } });
  expect(saveButton()).toBeDisabled();
});

test("a Test that does not pass keeps Save disabled", async () => {
  api.testMetaCrmSettings.mockResolvedValue({
    passed: false,
    checks: [{ key: "token", label: "Token and dataset", status: "fail", message: "Meta does not accept this access token.", detail: { metaError: "Meta 400 (code 190): Invalid OAuth" } }],
  });
  render(<MetaCrmTab />);
  await screen.findByText("Sync is ON");
  fireEvent.click(screen.getByRole("button", { name: "Test" }));
  expect(await screen.findByText(/Meta said: Meta 400 \(code 190\)/)).toBeInTheDocument();
  expect(saveButton()).toBeDisabled();
});

test("a Test that passed with a warning says so, shows Meta's words, and unlocks Save", async () => {
  api.testMetaCrmSettings.mockResolvedValue({
    passed: true,
    checks: [
      { key: "token", label: "Token and dataset", status: "warn", message: "Meta accepts the token, but could not confirm dataset 111222.", detail: { metaError: "Meta 400 (code 24): The requested resource does not exist" } },
      { key: "test_event", label: "Test event", status: "not_run", message: "Not run." },
    ],
  });
  render(<MetaCrmTab />);
  await screen.findByText("Sync is ON");
  fireEvent.click(screen.getByRole("button", { name: "Test" }));
  expect(await screen.findByText(/Test passed with a warning/)).toBeInTheDocument();
  expect(screen.getByText("! Warning")).toBeInTheDocument();
  expect(screen.getByText(/Meta said: Meta 400 \(code 24\)/)).toBeInTheDocument();
  await waitFor(() => expect(saveButton()).toBeEnabled());
});

test("Save sends the tested values, clears the token box, and a server refusal leaves Save locked", async () => {
  api.testMetaCrmSettings.mockResolvedValue(passed);
  api.saveMetaCrmSettings.mockRejectedValueOnce(new Error("Not saved: Meta does not accept this access token."));
  render(<MetaCrmTab />);
  await screen.findByText("Sync is ON");
  fireEvent.change(screen.getByLabelText("Access token"), { target: { value: TOKEN } });
  fireEvent.click(screen.getByRole("button", { name: "Test" }));
  await waitFor(() => expect(saveButton()).toBeEnabled());
  fireEvent.click(saveButton());
  expect(await screen.findByText(/Not saved/)).toBeInTheDocument();
  expect(saveButton()).toBeDisabled();

  api.saveMetaCrmSettings.mockResolvedValueOnce({ ...stored, datasetSource: "database", tokenSource: "database" });
  fireEvent.click(screen.getByRole("button", { name: "Test" }));
  await waitFor(() => expect(saveButton()).toBeEnabled());
  fireEvent.click(saveButton());
  expect(await screen.findByText(/Saved, and the sync is on/)).toBeInTheDocument();
  expect(api.saveMetaCrmSettings).toHaveBeenLastCalledWith({ datasetId: "111222", token: TOKEN });
  expect(screen.getByLabelText("Access token")).toHaveValue("");
});

test("the switch turns the sync off without sending any credential", async () => {
  api.setMetaCrmEnabled.mockResolvedValue({ ...stored, enabled: false });
  render(<MetaCrmTab />);
  fireEvent.click(await screen.findByLabelText("Sync on"));
  expect(await screen.findByText("Sync is OFF")).toBeInTheDocument();
  expect(api.setMetaCrmEnabled).toHaveBeenCalledWith(false);
});

test("a failed read shows the failure and a retry, never the form", async () => {
  api.getMetaCrmSettings.mockRejectedValueOnce(new Error("Database unavailable"));
  render(<MetaCrmTab />);
  expect(await screen.findByRole("alert")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
});

test("the gate itself: same values after a pass → yes; anything else → no", () => {
  const form = { datasetId: "1", token: "t", testEventCode: "" };
  expect(canSave({ passed: true, fingerprint: formFingerprint(form) }, form)).toBe(true);
  expect(canSave({ passed: false, fingerprint: formFingerprint(form) }, form)).toBe(false);
  expect(canSave({ passed: true, fingerprint: formFingerprint(form) }, { ...form, token: "u" })).toBe(false);
  expect(canSave(null, form)).toBe(false);
});
