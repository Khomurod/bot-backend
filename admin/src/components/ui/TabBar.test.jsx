/**
 * The shared tab bar.
 *
 * Every tabbed screen draws its tabs with this one component since the October
 * 2026 redesign, so what is under test is the contract those screens rely on:
 * every tab is shown (none hidden), the open tab is the one the PAGE says, a
 * click or a key reports the tab's key and nothing else, and screen readers
 * get a real tablist.
 */
import React, { useState } from "react";
import { describe, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import TabBar, { tabPanelProps } from "./TabBar";

const TABS = [
  { key: "one", label: "One" },
  { key: "two", label: "Two" },
  { key: "three", label: "Three" },
];

function Controlled({ onChange = () => {} }) {
  const [value, setValue] = useState("one");
  return (
    <TabBar
      tabs={TABS}
      value={value}
      onChange={(key) => { onChange(key); setValue(key); }}
      ariaLabel="Things"
    />
  );
}

describe("TabBar", () => {
  test("is a labelled tablist showing every tab, with the page's value selected", () => {
    render(<TabBar tabs={TABS} value="two" onChange={() => {}} ariaLabel="Things" />);
    expect(screen.getByRole("tablist", { name: "Things" })).toBeTruthy();
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["One", "Two", "Three"]);
    expect(screen.getByRole("tab", { name: "Two" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "One" })).toHaveAttribute("aria-selected", "false");
    // Only the open tab is in the page's Tab order (roving tabindex).
    expect(tabs.map((t) => t.tabIndex)).toEqual([-1, 0, -1]);
  });

  test("a click reports the clicked tab's key and does not choose for the page", async () => {
    const onChange = vi.fn();
    render(<TabBar tabs={TABS} value="one" onChange={onChange} ariaLabel="Things" />);
    await userEvent.click(screen.getByRole("tab", { name: "Three" }));
    expect(onChange).toHaveBeenCalledWith("three");
    // The page did not change its value, so the selection did not move either.
    expect(screen.getByRole("tab", { name: "One" })).toHaveAttribute("aria-selected", "true");
  });

  test("arrow keys, Home and End move focus only; Enter or Space opens the focused tab", async () => {
    const onChange = vi.fn();
    render(<Controlled onChange={onChange} />);
    const tab = (name) => screen.getByRole("tab", { name });
    tab("One").focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(tab("Two"));
    await userEvent.keyboard("{End}");
    expect(document.activeElement).toBe(tab("Three"));
    await userEvent.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(tab("One"));
    await userEvent.keyboard("{ArrowLeft}");
    expect(document.activeElement).toBe(tab("Three"));
    // Moving focus opened nothing — no tab was loaded on the way.
    expect(onChange).not.toHaveBeenCalled();
    expect(tab("One")).toHaveAttribute("aria-selected", "true");
    await userEvent.keyboard("{Enter}");
    expect(onChange).toHaveBeenLastCalledWith("three");
    expect(tab("Three")).toHaveAttribute("aria-selected", "true");
    await userEvent.keyboard("{Home}");
    expect(document.activeElement).toBe(tab("One"));
    await userEvent.keyboard(" ");
    expect(onChange).toHaveBeenLastCalledWith("one");
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  test("section tabs with idPrefix name the panel the page renders", () => {
    render(
      <>
        <TabBar tabs={TABS} value="two" onChange={() => {}} ariaLabel="Things" idPrefix="things" />
        <div {...tabPanelProps("things", "two")}>Two's content</div>
      </>,
    );
    const two = screen.getByRole("tab", { name: "Two" });
    expect(two).toHaveAttribute("id", "things-tab-two");
    expect(two).toHaveAttribute("aria-controls", "things-panel");
    const panel = screen.getByRole("tabpanel", { name: "Two" });
    expect(panel).toHaveAttribute("id", "things-panel");
    expect(panel.textContent).toBe("Two's content");
  });

  test("a filter bar is a group of pressed / not-pressed buttons, not tabs", async () => {
    const onChange = vi.fn();
    render(<TabBar filter tabs={TABS} value="one" onChange={onChange} ariaLabel="Which things" />);
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByRole("tab")).toBeNull();
    expect(screen.getByRole("group", { name: "Which things" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "One" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Two" })).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(screen.getByRole("button", { name: "Three" }));
    expect(onChange).toHaveBeenCalledWith("three");
  });

  test("tabs are buttons that never submit a surrounding form", () => {
    render(<TabBar tabs={TABS} value="one" onChange={() => {}} ariaLabel="Things" />);
    for (const tab of screen.getAllByRole("tab")) expect(tab).toHaveAttribute("type", "button");
  });
});
