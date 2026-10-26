/**
 * Settings → Gross Grand Prix: the video after the 4 PM celebration and the
 * Windows set-up that lets it play with sound (the owner, 26 October 2026).
 */
import React from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import GrossRaceTab from "./GrossRaceTab";
import { boardCommands } from "./grossRace/WindowsSoundCard";
import * as api from "../../api";

vi.mock("../../api", () => ({
  GROSS_RACE_VIDEO_URL: "/api/gross-race/video",
  GROSS_RACE_VIDEO_MAX_BYTES: 100 * 1024 * 1024,
  getCelebrationVideoStatus: vi.fn(),
  setCelebrationVideoPaused: vi.fn(),
  deleteCelebrationVideo: vi.fn(),
  uploadCelebrationVideo: vi.fn(),
}));

const on = {
  exists: true, bytes: 12 * 1024 * 1024, updatedAt: "2026-10-26T15:00:00.000Z",
  paused: false, pausedChangedAt: null, pausedChangedBy: null, pauseError: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  api.getCelebrationVideoStatus.mockResolvedValue(on);
});
afterEach(() => vi.restoreAllMocks());

test("shows the video that is on the server, with a preview", async () => {
  render(<GrossRaceTab />);
  expect(await screen.findByTestId("video-state")).toHaveTextContent("On");
  expect(screen.getByText(/12\.0 MB/)).toBeInTheDocument();
  expect(document.querySelector("video").getAttribute("src")).toMatch(/^\/api\/gross-race\/video\?v=/);
});

test("Pause pauses it, and the screen says the car still shows", async () => {
  api.setCelebrationVideoPaused.mockResolvedValue({ ok: true, paused: true });
  render(<GrossRaceTab />);
  await screen.findByTestId("video-state");
  api.getCelebrationVideoStatus.mockResolvedValue({ ...on, paused: true, pausedChangedBy: "owner", pausedChangedAt: on.updatedAt });
  fireEvent.click(screen.getByRole("button", { name: /Pause/ }));
  await waitFor(() => expect(api.setCelebrationVideoPaused).toHaveBeenCalledWith(true));
  expect(await screen.findByText(/the car still shows at 4 PM/)).toBeInTheDocument();
  expect(screen.getByTestId("video-state")).toHaveTextContent("Paused");
  fireEvent.click(screen.getByRole("button", { name: /Resume/ }));
  await waitFor(() => expect(api.setCelebrationVideoPaused).toHaveBeenLastCalledWith(false));
});

test("Delete asks first, and does nothing when the answer is no", async () => {
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  render(<GrossRaceTab />);
  fireEvent.click(await screen.findByRole("button", { name: /Delete/ }));
  expect(confirm).toHaveBeenCalled();
  expect(api.deleteCelebrationVideo).not.toHaveBeenCalled();

  confirm.mockReturnValue(true);
  api.deleteCelebrationVideo.mockResolvedValue({ ok: true, deleted: true });
  api.getCelebrationVideoStatus.mockResolvedValue({ ...on, exists: false, bytes: 0, updatedAt: null });
  fireEvent.click(screen.getByRole("button", { name: /Delete/ }));
  expect(await screen.findByText(/No video on the server/)).toBeInTheDocument();
  expect(api.deleteCelebrationVideo).toHaveBeenCalledTimes(1);
});

test("an upload must be an MP4 within the limit; a good one is sent as the file itself", async () => {
  api.uploadCelebrationVideo.mockResolvedValue({ ok: true, bytes: 3 });
  render(<GrossRaceTab />);
  await screen.findByTestId("video-state");
  const input = screen.getByLabelText("Choose a video");

  fireEvent.change(input, { target: { files: [new File(["x"], "clip.mov", { type: "video/quicktime" })] } });
  expect(await screen.findByText("Choose an MP4 video (.mp4).")).toBeInTheDocument();

  const huge = new File(["x"], "big.mp4", { type: "video/mp4" });
  Object.defineProperty(huge, "size", { value: 101 * 1024 * 1024 });
  fireEvent.change(input, { target: { files: [huge] } });
  expect(await screen.findByText(/the limit is 100\.0 MB/)).toBeInTheDocument();
  expect(api.uploadCelebrationVideo).not.toHaveBeenCalled();

  const good = new File(["abc"], "party.mp4", { type: "video/mp4" });
  fireEvent.change(input, { target: { files: [good] } });
  await waitFor(() => expect(api.uploadCelebrationVideo).toHaveBeenCalledWith(good, expect.any(Function)));
  expect(await screen.findByText(/Uploaded\. The screens play the new video/)).toBeInTheDocument();
});

test("a video uploaded while paused stays paused, and the screen says so", async () => {
  api.getCelebrationVideoStatus.mockResolvedValue({ ...on, paused: true });
  api.uploadCelebrationVideo.mockResolvedValue({ ok: true, bytes: 3 });
  render(<GrossRaceTab />);
  await screen.findByTestId("video-state");
  fireEvent.change(screen.getByLabelText("Choose a video"), { target: { files: [new File(["abc"], "p.mp4", { type: "video/mp4" })] } });
  expect(await screen.findByText(/still paused — press Resume/)).toBeInTheDocument();
});

test("no video yet: only the upload is offered", async () => {
  api.getCelebrationVideoStatus.mockResolvedValue({ ...on, exists: false, bytes: 0, updatedAt: null });
  render(<GrossRaceTab />);
  expect(await screen.findByText(/No video on the server/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Pause/ })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Delete/ })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Upload a video/ })).toBeInTheDocument();
});

test("the Windows command opens THIS server's /dispatchteam, full screen, with sound allowed, in its own profile", () => {
  const { chrome, edge } = boardCommands("https://hub.example.com");
  for (const command of [chrome, edge]) {
    expect(command).toMatch(/ --kiosk /);
    expect(command).toMatch(/ --autoplay-policy=no-user-gesture-required /);
    expect(command).toMatch(/ --user-data-dir="C:\\Wenze\w+" /);
    expect(command.endsWith(" https://hub.example.com/dispatchteam")).toBe(true);
  }
  expect(chrome.startsWith('"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"')).toBe(true);
});
