/**
 * Settings → System → Secrets: refused for anyone but a super administrator,
 * a clear stop when INTEGRATION_SECRET_KEY is missing, Preview before Save,
 * Save locked again by any edit, and no value on the screen. Made-up names.
 */
import React from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import SecretsTab from "./SecretsTab";
import * as api from "../../../api";

vi.mock("../../../api", () => ({
  getAppSecrets: vi.fn(),
  previewAppSecrets: vi.fn(),
  saveAppSecrets: vi.fn(),
  removeAppSecret: vi.fn(),
  restoreAppSecretsVersion: vi.fn(),
}));

const VIEW = {
  keyConfigured: true,
  boot: { status: "loaded", version: 2, names: ["BOT_TOKEN"], overridden: [] },
  latest: { id: 2, createdAt: "2026-11-04T10:00:00Z", createdBy: "owner", sameKey: true },
  values: [
    { scope: "both", name: "BOT_TOKEN", last4: "wxyz", inUseHere: true },
    { scope: "bot", name: "SHORT_ONE", last4: "", inUseHere: true },
  ],
  versions: [
    { id: 2, createdAt: "2026-11-04T10:00:00Z", createdBy: "owner", note: "upload for bot", valueCount: 2, sameKey: true, restoredFrom: null },
    { id: 1, createdAt: "2026-11-03T10:00:00Z", createdBy: "owner", note: "upload for bot", valueCount: 1, sameKey: true, restoredFrom: null },
  ],
};
const PREVIEW = {
  target: "bot", baseVersion: 2, added: [{ scope: "bot", name: "NEW_ONE" }], changed: [], removed: [],
  unchanged: 2, skipped: [{ name: "DATABASE_URL", reason: "stays in Coolify" }], duplicates: [], tokens: [],
  blocking: [], warnings: [], canSave: true, restartsThisApp: true,
};

beforeEach(() => {
  api.getAppSecrets.mockResolvedValue(VIEW);
  vi.spyOn(window, "confirm").mockReturnValue(true);
});
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

const textArea = () => screen.getByLabelText(".env contents");

test("anyone but a super administrator sees why, and nothing else", async () => {
  api.getAppSecrets.mockRejectedValue(Object.assign(new Error("Only a super administrator may do this"), { status: 403 }));
  render(<SecretsTab />);
  expect(await screen.findByText(/Only a super administrator can see or change/)).toBeTruthy();
  expect(screen.queryByLabelText(".env contents")).toBeNull();
});

test("without INTEGRATION_SECRET_KEY the page says what to do and stores nothing", async () => {
  api.getAppSecrets.mockResolvedValue({ ...VIEW, keyConfigured: false, latest: null, values: [], versions: [] });
  render(<SecretsTab />);
  expect(await screen.findByText(/is not set in Coolify, so nothing can be stored yet/)).toBeTruthy();
  expect(textArea().disabled).toBe(true);
});

test("stored values show names and last four characters only", async () => {
  render(<SecretsTab />);
  expect(await screen.findByText("BOT_TOKEN")).toBeTruthy();
  expect(screen.getByText("…wxyz")).toBeTruthy();
  expect(screen.getByText("(short value)")).toBeTruthy();
  expect(screen.getByText(/started with version 2/)).toBeTruthy();
});

test("Save needs a passing preview of exactly this text; an edit locks it again", async () => {
  api.previewAppSecrets.mockResolvedValue(PREVIEW);
  api.saveAppSecrets.mockResolvedValue({ versionId: 3, restarting: true, preview: PREVIEW });
  render(<SecretsTab />);
  await screen.findByText("BOT_TOKEN");
  const save = screen.getByRole("button", { name: "Save" });
  expect(save.disabled).toBe(true);

  fireEvent.change(textArea(), { target: { value: "NEW_ONE=hello-value" } });
  fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
  expect(await screen.findByText("NEW_ONE")).toBeTruthy();
  expect(screen.getByText(/stays in Coolify/)).toBeTruthy();
  expect(save.disabled).toBe(false);

  fireEvent.change(textArea(), { target: { value: "NEW_ONE=hello-value2" } });
  expect(save.disabled).toBe(true);
  fireEvent.change(textArea(), { target: { value: "NEW_ONE=hello-value" } });
  fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
  await waitFor(() => expect(save.disabled).toBe(false));

  fireEvent.click(save);
  expect(await screen.findByText(/Saved as version 3. The app is restarting/)).toBeTruthy();
  expect(api.saveAppSecrets).toHaveBeenCalledWith({ target: "bot", text: "NEW_ONE=hello-value", baseVersion: 2 });
  expect(textArea().value).toBe("");
});

test("a blocking problem keeps Save off and is listed", async () => {
  api.previewAppSecrets.mockResolvedValue({ ...PREVIEW, canSave: false, blocking: ["JWT_SECRET is missing — this app cannot start without it"] });
  render(<SecretsTab />);
  await screen.findByText("BOT_TOKEN");
  fireEvent.change(textArea(), { target: { value: "A=1" } });
  fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
  expect(await screen.findByText(/JWT_SECRET is missing/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Save" }).disabled).toBe(true);
});

test("an older version can be restored; the one in use cannot", async () => {
  api.restoreAppSecretsVersion.mockResolvedValue({ versionId: 3, restoredFrom: 1, restarting: true });
  render(<SecretsTab />);
  await screen.findByText("BOT_TOKEN");
  const restoreButtons = screen.getAllByRole("button", { name: "Restore" });
  expect(restoreButtons.length).toBe(1);
  fireEvent.click(restoreButtons[0]);
  expect(await screen.findByText(/Version 1 restored as version 3/)).toBeTruthy();
  expect(api.restoreAppSecretsVersion).toHaveBeenCalledWith(1);
});
