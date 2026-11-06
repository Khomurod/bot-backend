/**
 * A birthday on the board: an employee with the card that went to Telegram,
 * a driver with the name and the truck; a card that does not load falls back
 * to the name.
 */
import React from "react";
import { describe, expect, test } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import BirthdayOverlay from "./BirthdayOverlay";

describe("BirthdayOverlay", () => {
  test("an employee: Happy Birthday and the card from the board's own route", () => {
    render(<BirthdayOverlay birthday={{ key: "employee-7-2026-11-06", kind: "employee", name: "Testbek", subtitle: "Tom", card: "/api/gross-race/birthday-card/employee-7-2026-11-06" }} />);
    const dialog = screen.getByRole("dialog", { name: "Happy Birthday" });
    expect(dialog).toHaveTextContent("Happy Birthday!");
    expect(screen.getByRole("img", { name: "Testbek's birthday card" })).toHaveAttribute("src", "/api/gross-race/birthday-card/employee-7-2026-11-06");
  });

  test("a card that does not load: the name and the American name instead", () => {
    render(<BirthdayOverlay birthday={{ key: "employee-7", kind: "employee", name: "Testbek", subtitle: "Tom", card: "/api/gross-race/birthday-card/employee-7" }} />);
    fireEvent.error(screen.getByRole("img"));
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog")).toHaveTextContent("Testbek");
    expect(screen.getByRole("dialog")).toHaveTextContent("Tom");
  });

  test("an employee without a card: the name", () => {
    render(<BirthdayOverlay birthday={{ key: "employee-8", kind: "employee", name: "Second", subtitle: null, card: null }} />);
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog")).toHaveTextContent("Second");
  });

  test("a driver: the name, large, and the truck", () => {
    render(<BirthdayOverlay birthday={{ key: "driver-42", kind: "driver", name: "John Smith", truck: "1109", card: null }} />);
    expect(screen.getByRole("dialog")).toHaveTextContent("John Smith");
    expect(screen.getByRole("dialog")).toHaveTextContent("Truck 1109");
  });

  test("a driver with no truck recorded: the name alone", () => {
    render(<BirthdayOverlay birthday={{ key: "driver-43", kind: "driver", name: "Ann Lee", truck: null }} />);
    expect(screen.getByRole("dialog")).not.toHaveTextContent("Truck");
  });
});
