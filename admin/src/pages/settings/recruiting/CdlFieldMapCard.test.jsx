/**
 * Settings → Safety Approvals → 6. CDL → Bitrix fields (owner, 14 November
 * 2026). The Bitrix field lists are read only when asked; each CDL item maps
 * to one contact or deal field or stays unmapped (the comment); one field
 * takes one item; the save sends exactly what is on screen. The reads below
 * the table are counts and reasons — never a value.
 */
import React from "react";
import { beforeEach, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import CdlFieldMapCard from "./CdlFieldMapCard";
import * as api from "../../../api";

vi.mock("../../../api", () => ({
  getHiringCdl: vi.fn(),
  readHiringCdlBitrixFields: vi.fn(),
  saveHiringCdlMapping: vi.fn(),
}));

const ITEMS = [
  { key: "date_of_birth", label: "Date of birth" },
  { key: "license_number", label: "Licence number" },
  { key: "license_class", label: "Class" },
];
const FIELDS = {
  ok: true,
  contact: [{ code: "BIRTHDATE", label: "Date of birth", type: "date" }, { code: "UF_CRM_CDL", label: "CDL number", type: "string" }],
  deal: [{ code: "UF_CRM_CLASS", label: "CDL class", type: "enumeration" }],
};

beforeEach(() => {
  vi.clearAllMocks();
  api.getHiringCdl.mockResolvedValue({
    items: ITEMS,
    mapping: [{ item: "date_of_birth", entity: "contact", fieldCode: "BIRTHDATE", fieldLabel: "Date of birth", fieldType: "date" }],
    recent: [{ id: 1, status: "written", providerKey: "anthropic", itemsWritten: 9, itemsInComment: 3, dealId: 61, createdAt: "2026-11-14T10:00:00Z" },
      { id: 2, status: "name_differs", providerKey: "gemini", itemsWritten: 0, itemsInComment: 0, createdAt: "2026-11-14T09:00:00Z" }],
  });
  api.readHiringCdlBitrixFields.mockResolvedValue(FIELDS);
  api.saveHiringCdlMapping.mockResolvedValue({ mapping: [] });
});

test("the saved mapping shows before Bitrix is read; nothing is read from Bitrix until asked", async () => {
  render(<CdlFieldMapCard />);
  const dob = await screen.findByLabelText("Date of birth");
  expect(dob.value).toBe("contact:BIRTHDATE");
  expect(screen.getByLabelText("Licence number")).toBeDisabled();
  expect(api.readHiringCdlBitrixFields).not.toHaveBeenCalled();
  expect(screen.getByText(/9 written, 3 in a comment — deal #61/)).toBeTruthy();
  expect(screen.getByText(/Name differs from the post — nothing written/)).toBeTruthy();
});

test("read the fields, map an item to a deal field, save exactly that", async () => {
  render(<CdlFieldMapCard />);
  fireEvent.click(await screen.findByRole("button", { name: "Read the fields from Bitrix" }));
  await waitFor(() => expect(screen.getByLabelText("Licence number")).not.toBeDisabled());
  fireEvent.change(screen.getByLabelText("Licence number"), { target: { value: "contact:UF_CRM_CDL" } });
  fireEvent.change(screen.getByLabelText("Class"), { target: { value: "deal:UF_CRM_CLASS" } });
  fireEvent.change(screen.getByLabelText("Date of birth"), { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "Save mapping" }));
  await waitFor(() => expect(api.saveHiringCdlMapping).toHaveBeenCalledWith([
    { item: "license_number", entity: "contact", fieldCode: "UF_CRM_CDL", fieldLabel: "CDL number", fieldType: "string" },
    { item: "license_class", entity: "deal", fieldCode: "UF_CRM_CLASS", fieldLabel: "CDL class", fieldType: "enumeration" },
  ]));
  expect(await screen.findByText("CDL field mapping saved.")).toBeTruthy();
});

test("a field another item already takes cannot be picked twice", async () => {
  render(<CdlFieldMapCard />);
  fireEvent.click(await screen.findByRole("button", { name: "Read the fields from Bitrix" }));
  await waitFor(() => expect(screen.getByLabelText("Licence number")).not.toBeDisabled());
  const option = Array.from(screen.getByLabelText("Licence number").querySelectorAll("option"))
    .find((o) => o.value === "contact:BIRTHDATE");
  expect(option.disabled).toBe(true);
});

test("Bitrix that cannot be read says so, in its own words", async () => {
  api.readHiringCdlBitrixFields.mockResolvedValue({ ok: false, error: "Bitrix crm.deal.fields: Access denied" });
  render(<CdlFieldMapCard />);
  fireEvent.click(await screen.findByRole("button", { name: "Read the fields from Bitrix" }));
  expect(await screen.findByText(/Bitrix could not be read: Bitrix crm.deal.fields: Access denied/)).toBeTruthy();
});

test("a refused save is shown", async () => {
  api.saveHiringCdlMapping.mockRejectedValue(new Error("Two CDL items go to the same Bitrix field (UF_CRM_CDL)."));
  render(<CdlFieldMapCard />);
  fireEvent.click(await screen.findByRole("button", { name: "Save mapping" }));
  expect(await screen.findByText(/Two CDL items go to the same Bitrix field/)).toBeTruthy();
});
