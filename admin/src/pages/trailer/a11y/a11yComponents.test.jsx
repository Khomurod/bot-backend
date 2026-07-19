/**
 * Component tests (§21) for the shared accessible building blocks: Modal focus
 * behavior, keyboard-operable table rows, arrow-key tabs, and pagination.
 * Rendered with React Testing Library in jsdom — real mount, real events.
 */
import React, { useState } from "react";
import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Modal, Pagination, Table } from "../TrailerUi";
import SectionTabs, { TabPanel } from "../sections/SectionTabs";

describe("Modal", () => {
  test("has dialog semantics and moves focus inside on open", () => {
    render(
      <Modal title="Confirm pickup" subtitle="Step 1" onClose={() => {}}>
        <button type="button">First action</button>
      </Modal>,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByRole("heading", { name: "Confirm pickup" })).toBeInTheDocument();
    // Focus landed on the first focusable element inside the dialog.
    expect(document.activeElement?.textContent).toBe("First action");
  });

  test("Escape closes when allowed; a busy dialog ignores it", () => {
    const onClose = vi.fn();
    const { rerender } = render(<Modal title="T" onClose={onClose}><button>x</button></Modal>);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);

    rerender(<Modal title="T" onClose={undefined}><button>x</button></Modal>);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1); // unchanged — busy dialogs don't close
  });

  test("restores focus to the trigger on close", () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <div>
          <button type="button" onClick={() => setOpen(true)}>Open dialog</button>
          {open && <Modal title="T" onClose={() => setOpen(false)}><button>inside</button></Modal>}
        </div>
      );
    }
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Open dialog" });
    trigger.focus();
    fireEvent.click(trigger);
    expect(document.activeElement?.textContent).toBe("inside");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(document.activeElement).toBe(trigger);
  });
});

describe("Table keyboard rows", () => {
  const rows = [{ id: 1, unit_number: "1045" }, { id: 2, unit_number: "1088" }];
  const columns = [{ key: "unit_number", label: "Trailer" }];

  test("clickable rows are focusable buttons that activate on Enter and Space", () => {
    const onRow = vi.fn();
    render(<Table rows={rows} columns={columns} onRow={onRow} />);
    const row = screen.getByRole("button", { name: /open 1045/i });
    expect(row).toHaveAttribute("tabindex", "0");
    fireEvent.keyDown(row, { key: "Enter" });
    fireEvent.keyDown(row, { key: " " });
    expect(onRow).toHaveBeenCalledTimes(2);
    expect(onRow).toHaveBeenCalledWith(rows[0]);
  });

  test("non-clickable tables render plain rows", () => {
    render(<Table rows={rows} columns={columns} />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("SectionTabs", () => {
  const tabs = [
    { key: "all", label: "All trailers" },
    { key: "map", label: "Map" },
    { key: "updates", label: "Updates" },
  ];

  test("arrow keys move selection with wrap; Home/End jump", () => {
    const onChange = vi.fn();
    render(<SectionTabs tabs={tabs} active="all" onChange={onChange} idBase="t" />);
    const tablist = screen.getByRole("tablist");
    fireEvent.keyDown(tablist, { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith("map");
    fireEvent.keyDown(tablist, { key: "ArrowLeft" });
    expect(onChange).toHaveBeenLastCalledWith("updates"); // wraps backwards
    fireEvent.keyDown(tablist, { key: "End" });
    expect(onChange).toHaveBeenLastCalledWith("updates");
  });

  test("only the selected tab is in the tab sequence and panels are wired", () => {
    render(
      <div>
        <SectionTabs tabs={tabs} active="map" onChange={() => {}} idBase="t" />
        <TabPanel idBase="t" activeKey="map">Map content</TabPanel>
      </div>,
    );
    const selected = screen.getByRole("tab", { name: "Map" });
    expect(selected).toHaveAttribute("aria-selected", "true");
    expect(selected).toHaveAttribute("tabindex", "0");
    for (const other of ["All trailers", "Updates"]) {
      expect(screen.getByRole("tab", { name: other })).toHaveAttribute("tabindex", "-1");
    }
    const panel = screen.getByRole("tabpanel");
    expect(panel).toHaveAttribute("aria-labelledby", selected.id);
    expect(selected).toHaveAttribute("aria-controls", panel.id);
  });
});

describe("Pagination", () => {
  test("shows totals, disables edges, and pages forward", () => {
    const onPage = vi.fn();
    render(<Pagination page={1} pageSize={25} total={60} onPage={onPage} />);
    expect(screen.getByText(/60 results/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(onPage).toHaveBeenCalledWith(2);
  });

  test("renders nothing when there are no results", () => {
    const { container } = render(<Pagination page={1} pageSize={25} total={0} onPage={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });
});
