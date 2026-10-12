/**
 * The 4 PM celebration on screen: the leader's name and the message always;
 * the 3D car (and its credit) only when the screen can draw it.
 */
import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const scene = vi.hoisted(() => ({ webgl: false, mount: null, dispose: null }));
vi.mock("./carScene", () => ({
  supportsWebGL: () => scene.webgl,
  mountCarScene: (...args) => scene.mount(...args),
  preloadCar: () => Promise.resolve(),
}));

import CelebrationOverlay from "./CelebrationOverlay";
import { MESSAGE } from "./celebrationTime";

const winner = { id: "Ann Example", name: "Ann Example", rank: 1, gross: 21500 };

afterEach(() => {
  scene.webgl = false;
  scene.mount = null;
});

describe("CelebrationOverlay", () => {
  test("without WebGL: the name, the message and a trophy, no car and no credit", () => {
    render(<CelebrationOverlay winner={winner} view="dispatchers" />);
    expect(screen.getByRole("dialog", { name: "Today's leader" })).toBeInTheDocument();
    expect(screen.getByText("Ann Example")).toBeInTheDocument();
    expect(screen.getByText(MESSAGE)).toBeInTheDocument();
    expect(screen.getByText("4:00 PM · 1st place")).toBeInTheDocument();
    expect(document.querySelector(".gr-celebration-trophy")).not.toBeNull();
    expect(screen.queryByText(/CC BY 4.0/)).not.toBeInTheDocument();
  });

  test("with WebGL: the car comes on with its credit, and is released when the celebration ends", async () => {
    scene.webgl = true;
    const dispose = vi.fn();
    scene.mount = vi.fn(async () => ({ dispose }));
    const { unmount } = render(<CelebrationOverlay winner={winner} view="teams" />);
    expect(screen.getByText("4:00 PM · 1st place team")).toBeInTheDocument();
    await waitFor(() => expect(document.querySelector(".gr-celebration-car.is-on")).not.toBeNull());
    expect(screen.getByText(/“Car Concept” by Eric Chadwick.*CC BY 4\.0/)).toBeInTheDocument();
    expect(scene.mount).toHaveBeenCalledWith(expect.any(HTMLCanvasElement), { durationMs: 12000 });
    unmount();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  test("a car that fails to load leaves the words and the trophy", async () => {
    scene.webgl = true;
    scene.mount = vi.fn(async () => { throw new Error("no model"); });
    render(<CelebrationOverlay winner={winner} view="dispatchers" />);
    await waitFor(() => expect(document.querySelector(".gr-celebration-trophy")).not.toBeNull());
    expect(screen.getByText("Ann Example")).toBeInTheDocument();
  });
});
