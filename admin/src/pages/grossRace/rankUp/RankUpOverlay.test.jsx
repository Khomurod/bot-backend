/**
 * The climb card: the name large, the places moved and whom they passed; a new
 * leader "takes 1st place"; the Test sound card says what the screen can play.
 */
import React from "react";
import { describe, expect, test } from "vitest";
import { render, screen } from "@testing-library/react";
import RankUpOverlay from "./RankUpOverlay";

describe("RankUpOverlay", () => {
  test("a climb: who, from where to where, whom they passed", () => {
    render(<RankUpOverlay card={{ name: "Cy Example", rank: 3, from: 5, passed: "Bo Example", leader: false }} />);
    const card = screen.getByRole("status");
    expect(card).toHaveTextContent("Moving up");
    expect(card).toHaveTextContent("Cy Example");
    expect(card).toHaveTextContent("↑ 5th → 3rd");
    expect(card).toHaveTextContent("passed Bo Example");
    expect(card.className).not.toMatch(/gr-rankup-leader/);
  });

  test("a new leader: the accent card, and takes 1st place", () => {
    render(<RankUpOverlay card={{ name: "Ann Example", rank: 1, from: 2, passed: "Bo Example", leader: true }} />);
    const card = screen.getByRole("status");
    expect(card).toHaveTextContent("New leader");
    expect(card).toHaveTextContent("takes 1st place");
    expect(card).not.toHaveTextContent("↑");
    expect(card.className).toMatch(/gr-rankup-leader/);
  });

  test("nobody passed (a racer moving into an empty place): no passed line", () => {
    render(<RankUpOverlay card={{ name: "Cy Example", rank: 3, from: 4, passed: "", leader: false }} />);
    expect(screen.getByRole("status")).not.toHaveTextContent("passed");
  });

  test("the Test sound card says whether the chime played and whether sound may start by itself", () => {
    const { rerender } = render(<RankUpOverlay card={{ name: "Sound test", rank: 3, from: 5, test: true, autoplay: "blocked", chimed: true }} />);
    expect(screen.getByRole("status")).toHaveTextContent(/chime played/);
    expect(screen.getByRole("status")).toHaveTextContent(/blocked — start Chrome with the shortcut in Settings → Gross Grand Prix/);
    rerender(<RankUpOverlay card={{ name: "Sound test", rank: 3, from: 5, test: true, autoplay: "allowed", chimed: false }} />);
    expect(screen.getByRole("status")).toHaveTextContent(/chime did not play/);
    expect(screen.getByRole("status")).toHaveTextContent(/allowed — the chime plays by itself/);
  });

  test("no card, nothing on screen", () => {
    const { container } = render(<RankUpOverlay card={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});
