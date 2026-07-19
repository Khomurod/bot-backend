/**
 * Component tests (§21) for the accessible searchable Combobox: typing filters,
 * keyboard selection, ARIA wiring, and clearing. Real mount + user events.
 */
import React from "react";
import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import Combobox from "./Combobox";

const OPTIONS = [
  { value: "1", label: "Acme Logistics", hint: "Jane" },
  { value: "2", label: "Globex Freight", hint: "Bob" },
  { value: "3", label: "Acme Rentals" },
];

function setup(props = {}) {
  const onChange = vi.fn();
  render(<Combobox options={OPTIONS} value="" onChange={onChange}
    label="Company" placeholder="Search…" {...props} />);
  return { onChange, input: screen.getByRole("combobox") };
}

describe("Combobox", () => {
  test("typing filters the listbox options", () => {
    const { input } = setup();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "acme" } });
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(2);
    expect(options[0]).toHaveTextContent("Acme Logistics");
  });

  test("arrow keys + Enter choose the active option", () => {
    const { input, onChange } = setup();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "a" } });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalled();
    const chosen = OPTIONS.find((o) => o.value === onChange.mock.calls[0][0]);
    expect(chosen).toBeTruthy();
  });

  test("mouse selection works and Escape closes the list", () => {
    const { input, onChange } = setup();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "globex" } });
    fireEvent.mouseDown(screen.getByRole("option", { name: /Globex/ }));
    expect(onChange).toHaveBeenCalledWith("2");

    fireEvent.focus(input);
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  test("ARIA contract: expanded state, listbox control, active descendant", () => {
    const { input } = setup();
    expect(input).toHaveAttribute("aria-expanded", "false");
    fireEvent.focus(input);
    expect(input).toHaveAttribute("aria-expanded", "true");
    fireEvent.change(input, { target: { value: "acme" } });
    const listId = input.getAttribute("aria-controls");
    expect(screen.getByRole("listbox").id).toBe(listId);
    expect(input.getAttribute("aria-activedescendant")).toMatch(new RegExp(`^${listId}-opt-`));
  });

  test("a selected value shows its label and can be cleared", () => {
    const onChange = vi.fn();
    render(<Combobox options={OPTIONS} value="1" onChange={onChange} label="Company" />);
    expect(screen.getByRole("combobox")).toHaveValue("Acme Logistics");
    fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(onChange).toHaveBeenCalledWith("");
  });

  test("no matches shows the empty text, not a dead dropdown", () => {
    const { input } = setup({ emptyText: "No matching company" });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "zzz" } });
    expect(screen.getByText("No matching company")).toBeInTheDocument();
  });
});
