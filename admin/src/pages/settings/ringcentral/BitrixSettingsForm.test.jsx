/**
 * Settings → RingCentral → Bitrix24: the connection form.
 *
 * Bitrix used to be configured on the host; this is where it is entered now.
 * What the form must get right:
 *
 *   ① the webhook is a secret — blank keeps the stored one and is NOT sent,
 *      only a typed value is, and the page never displays the URL;
 *   ② a NAME in the assignee slot is refused before it reaches the server —
 *      that is the production mistake this replaces;
 *   ③ a deal needs both pipeline ids;
 *   ④ seconds in the UI become milliseconds on the wire;
 *   ⑤ an assignee the form would refuse is never PRE-FILLED into the field
 *      (the environment's "Tom Robinson" was, so Save looked dead);
 *   ⑥ every refused save says why right under the button, not only in the
 *      tab banner that is off-screen when the click happens.
 */
import React from "react";
import { afterEach, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import BitrixSettingsForm from "./BitrixSettingsForm";
import { updateBitrixSettings } from "../../../api";

vi.mock("../../../api", () => ({ updateBitrixSettings: vi.fn() }));

afterEach(() => { vi.clearAllMocks(); });

const SETTINGS = {
  enabled: true, webhookSet: true, webhookHost: "wenze.bitrix24.com",
  entity: "lead", assignedById: null, assignedByIdRaw: "Tom Robinson", assignedByIdIgnored: true,
  sourceId: "WEB", sourceDescription: "Facebook / bot-backend",
  dealCategoryId: null, dealStageId: null, assigneeWaitMs: 25000,
  fromEnv: { enabled: false, webhookUrl: true, entity: false, assignedById: true, assigneeWaitMs: false },
  updatedAt: null,
};

function open(settings = SETTINGS) {
  const onMessage = vi.fn();
  const onSaved = vi.fn();
  render(<BitrixSettingsForm settings={settings} onSaved={onSaved} onMessage={onMessage} />);
  return { onMessage, onSaved };
}

const saveButton = () => screen.getByRole("button", { name: /Save Bitrix24 settings/i });
const assigneeField = () => screen.getByPlaceholderText(/blank = let a Bitrix rule assign/i);

test("the page shows the host, never the URL, and says the webhook comes from the environment", () => {
  open();
  expect(screen.getByText(/points at wenze.bitrix24.com/)).toBeTruthy();
  expect(screen.getByText(/\(from environment\)/)).toBeTruthy();
  expect(document.body.textContent).not.toMatch(/rest\/1\//);
});

test("the ignored env assignee is called out in red on the field it belongs to", () => {
  open();
  expect(screen.getByText(/Currently "Tom Robinson", which Bitrix ignores/)).toBeTruthy();
});

test("saving with a blank webhook field does not send a webhook at all", async () => {
  updateBitrixSettings.mockResolvedValue({ ...SETTINGS, assignedByIdRaw: "", assignedByIdIgnored: false });
  const { onSaved } = open();
  fireEvent.change(assigneeField(), { target: { value: "" } });
  fireEvent.click(saveButton());

  await waitFor(() => expect(updateBitrixSettings).toHaveBeenCalled());
  const payload = updateBitrixSettings.mock.calls[0][0];
  expect("webhookUrl" in payload).toBe(false);
  expect("clearWebhookUrl" in payload).toBe(false);
  expect(payload.assignedById).toBe("");
  expect(payload.assigneeWaitMs).toBe(25000);
  expect(onSaved).toHaveBeenCalled();
});

test("a typed webhook is sent, then the field is emptied again", async () => {
  updateBitrixSettings.mockResolvedValue(SETTINGS);
  open();
  const field = screen.getByPlaceholderText(/leave blank to keep current/i);
  fireEvent.change(field, { target: { value: "https://wenze.bitrix24.com/rest/1/new-token/" } });
  fireEvent.change(assigneeField(), { target: { value: "17" } });
  fireEvent.click(saveButton());

  await waitFor(() => expect(updateBitrixSettings).toHaveBeenCalled());
  expect(updateBitrixSettings.mock.calls[0][0].webhookUrl).toBe("https://wenze.bitrix24.com/rest/1/new-token/");
  await waitFor(() => expect(field.value).toBe(""));
});

test("a name in the assignee slot is refused before anything is sent", async () => {
  const { onMessage } = open();
  fireEvent.change(assigneeField(), { target: { value: "Tom Robinson" } });
  fireEvent.click(saveButton());

  await waitFor(() => expect(onMessage).toHaveBeenCalled());
  expect(onMessage.mock.calls[0][0].type).toBe("error");
  expect(onMessage.mock.calls[0][0].text).toMatch(/not a Bitrix user id/);
  expect(updateBitrixSettings).not.toHaveBeenCalled();
});

test("a pasted profile URL is cleaned to the id on the wire", async () => {
  updateBitrixSettings.mockResolvedValue(SETTINGS);
  open();
  fireEvent.change(assigneeField(), { target: { value: "/company/personal/user/17/" } });
  fireEvent.click(saveButton());
  await waitFor(() => expect(updateBitrixSettings).toHaveBeenCalled());
  expect(updateBitrixSettings.mock.calls[0][0].assignedById).toBe("17");
});

test("switching to deal reveals the pipeline ids and requires both", async () => {
  const { onMessage } = open();
  fireEvent.change(assigneeField(), { target: { value: "" } });
  fireEvent.change(screen.getByDisplayValue("lead"), { target: { value: "deal" } });
  expect(screen.getByText(/Deal category ID/)).toBeTruthy();
  fireEvent.click(saveButton());
  await waitFor(() => expect(onMessage).toHaveBeenCalled());
  expect(onMessage.mock.calls[0][0].text).toMatch(/category id and a stage id/);
  expect(updateBitrixSettings).not.toHaveBeenCalled();
});

test("seconds in the field are sent as milliseconds", async () => {
  updateBitrixSettings.mockResolvedValue(SETTINGS);
  open();
  fireEvent.change(assigneeField(), { target: { value: "" } });
  fireEvent.change(screen.getByDisplayValue("25"), { target: { value: "40" } });
  fireEvent.click(saveButton());
  await waitFor(() => expect(updateBitrixSettings).toHaveBeenCalled());
  expect(updateBitrixSettings.mock.calls[0][0].assigneeWaitMs).toBe(40000);
});

test("forgetting the stored webhook sends the clear flag and no URL", async () => {
  updateBitrixSettings.mockResolvedValue({ ...SETTINGS, webhookSet: false });
  open();
  fireEvent.change(assigneeField(), { target: { value: "" } });
  fireEvent.click(screen.getByLabelText(/Forget the stored webhook/));
  fireEvent.click(saveButton());
  await waitFor(() => expect(updateBitrixSettings).toHaveBeenCalled());
  const payload = updateBitrixSettings.mock.calls[0][0];
  expect(payload.clearWebhookUrl).toBe(true);
  expect("webhookUrl" in payload).toBe(false);
});

test("a server rejection is shown, not swallowed", async () => {
  updateBitrixSettings.mockRejectedValue(new Error("Entity must be \"lead\" or \"deal\"."));
  const { onMessage } = open();
  fireEvent.change(assigneeField(), { target: { value: "" } });
  fireEvent.click(saveButton());
  await waitFor(() => expect(onMessage).toHaveBeenCalledWith({ type: "error", text: 'Entity must be "lead" or "deal".' }));
});

test("an ignored environment assignee is shown in red but NOT pre-filled — the field starts blank", () => {
  open();
  expect(assigneeField().value).toBe("");
  expect(screen.getByText(/Currently "Tom Robinson", which Bitrix ignores/)).toBeTruthy();
});

test("a stored numeric assignee IS pre-filled", () => {
  open({ ...SETTINGS, assignedById: 17, assignedByIdRaw: "17", assignedByIdIgnored: false });
  expect(assigneeField().value).toBe("17");
});

test("saving straight away with the ignored value replaces it with 'nobody' rather than resending the name", async () => {
  updateBitrixSettings.mockResolvedValue({ ...SETTINGS, assignedByIdRaw: "", assignedByIdIgnored: false });
  open();
  fireEvent.click(saveButton());
  await waitFor(() => expect(updateBitrixSettings).toHaveBeenCalled());
  expect(updateBitrixSettings.mock.calls[0][0].assignedById).toBe("");
  expect(screen.queryByRole("alert")).toBeNull();
});

test("a refused assignee is explained right under the Save button", async () => {
  open();
  fireEvent.change(assigneeField(), { target: { value: "Tom Robinson" } });
  fireEvent.click(saveButton());
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toMatch(/^Not saved: /);
  expect(alert.textContent).toMatch(/not a Bitrix user id/);
  expect(updateBitrixSettings).not.toHaveBeenCalled();
});

test("a server rejection is printed under the button too, and editing the field clears it", async () => {
  updateBitrixSettings.mockRejectedValue(new Error("Entity must be \"lead\" or \"deal\"."));
  open();
  fireEvent.click(saveButton());
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toBe('Not saved: Entity must be "lead" or "deal".');

  fireEvent.change(assigneeField(), { target: { value: "17" } });
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
});
