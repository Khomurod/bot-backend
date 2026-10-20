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

test("every listed model is shown; only a chat model not yet chosen can be picked", () => {
  const onChange = vi.fn();
  render(<ModelChainEditor chain={["claude-haiku-5-5"]} discovered={DISCOVERED} onChange={onChange} />);
  const options = screen.getAllByRole("option").filter((o) => o.value);
  expect(options.map((o) => o.value).sort()).toEqual(
    ["claude-haiku-5-5", "claude-opus-5-5", "claude-sonnet-5-5", "text-embedding"]
  );
  const pickable = options.filter((o) => !o.disabled).map((o) => o.value);
  expect(pickable).toEqual(["claude-opus-5-5", "claude-sonnet-5-5"]);
  expect(screen.getByRole("option", { name: /text-embedding — not a chat model/ })).toBeDisabled();

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

test("a model waiting for its allowance is shown as such, in the list and in the drop-down", () => {
  const later = new Date(Date.now() + 3 * 3600 * 1000).toISOString();
  render(
    <ModelChainEditor
      chain={["claude-haiku-5-5"]}
      discovered={DISCOVERED}
      cooldowns={{ "claude-haiku-5-5": { until: later }, "claude-opus-5-5": { until: later } }}
      onChange={vi.fn()}
    />
  );
  expect(screen.getByText(/quota spent — back at/)).toBeInTheDocument();
  const waiting = screen.getByRole("group", { name: /Quota spent/ });
  expect(waiting.textContent).toMatch(/claude-opus-5-5/);
  expect(screen.getByRole("option", { name: /claude-opus-5-5.*back at/ })).not.toBeDisabled();
});

test("a pause that has already ended is not shown", () => {
  const earlier = new Date(Date.now() - 60_000).toISOString();
  render(
    <ModelChainEditor chain={["claude-haiku-5-5"]} discovered={DISCOVERED}
      cooldowns={{ "claude-haiku-5-5": { until: earlier } }} onChange={vi.fn()} />
  );
  expect(screen.queryByText(/quota spent/)).toBeNull();
});
