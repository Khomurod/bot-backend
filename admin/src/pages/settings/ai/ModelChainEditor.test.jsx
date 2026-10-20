/**
 * Choosing a provider's models by hand, from what the provider listed (owner,
 * October 2026: "I must be able to choose the models myself").
 */
import React from "react";
import { expect, test, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import ModelChainEditor from "./ModelChainEditor";

const DISCOVERED = [
  { id: "claude-haiku-5-5", chat: true, free: "unknown" },
  { id: "claude-sonnet-5-5", chat: true, free: "unknown" },
  { id: "claude-opus-5-5", chat: true, free: "unknown" },
  { id: "text-embedding", chat: false, free: "unknown" },
];

test("a listed chat model can be added; non-chat and already-chosen ones are not offered", () => {
  const onChange = vi.fn();
  render(<ModelChainEditor chain={["claude-haiku-5-5"]} discovered={DISCOVERED} onChange={onChange} />);
  const offered = screen.getAllByRole("option").map((o) => o.value).filter(Boolean);
  expect(offered).toEqual(["claude-opus-5-5", "claude-sonnet-5-5"]);

  fireEvent.change(screen.getByLabelText("Model to add"), { target: { value: "claude-opus-5-5" } });
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  expect(onChange).toHaveBeenCalledWith(["claude-haiku-5-5", "claude-opus-5-5"]);
});

test("order and removal are the operator's", () => {
  const onChange = vi.fn();
  render(<ModelChainEditor chain={["a", "b"]} discovered={[]} onChange={onChange} />);
  fireEvent.click(screen.getByRole("button", { name: "Move b up" }));
  expect(onChange).toHaveBeenLastCalledWith(["b", "a"]);
  fireEvent.click(screen.getByRole("button", { name: "Remove a" }));
  expect(onChange).toHaveBeenLastCalledWith(["b"]);
});

test("an id can be typed for a provider whose listing is incomplete; an empty chain says so", () => {
  const onChange = vi.fn();
  render(<ModelChainEditor chain={[]} discovered={[]} onChange={onChange} />);
  expect(screen.getByText(/nothing to ask/)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Model id to add"), { target: { value: " my-model " } });
  fireEvent.click(screen.getByRole("button", { name: "Add typed" }));
  expect(onChange).toHaveBeenCalledWith(["my-model"]);
});
