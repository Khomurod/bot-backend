/**
 * The driver modal's identity panel: a placed driver shows every chat and truck
 * in time; an unplaced one says so, rather than showing nothing.
 */
import React from "react";
import { describe, expect, test, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";

import * as api from "../../api";
import PersonIdentityPanel from "./PersonIdentityPanel";

afterEach(() => vi.restoreAllMocks());

describe("PersonIdentityPanel", () => {
  test("an unplaced driver is told how they get placed", () => {
    const spy = vi.spyOn(api, "getPersonIdentity");
    render(<PersonIdentityPanel personId={null} />);
    expect(screen.getByText(/Not placed yet/)).toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();
  });

  test("a placed driver shows the chats and trucks they have held", async () => {
    vi.spyOn(api, "getPersonIdentity").mockResolvedValue({
      id: 7,
      displayName: "RUSLAN ABDULLAEV",
      mergedFrom: [{ id: 9, displayName: "R. ABDULLAYEV" }],
      groups: [
        { id: 2, groupName: "WENZE UNIT # 27 RUSLAN ABDULLAEV (new)", startedAt: "2026-09-01T00:00:00Z", endedAt: null, associationSource: "name_key" },
        { id: 1, groupName: "WENZE UNIT # 27 RUSLAN ABDULLAEV", startedAt: "2026-06-01T00:00:00Z", endedAt: "2026-09-01T00:00:00Z", associationSource: "backfill" },
      ],
      units: [
        { id: 2, unitNumber: "322", startedAt: "2026-09-01T00:00:00Z", endedAt: null },
        { id: 1, unitNumber: "320", startedAt: "2026-06-01T00:00:00Z", endedAt: "2026-09-01T00:00:00Z" },
      ],
    });
    render(<PersonIdentityPanel personId={7} />);

    expect(await screen.findByText("RUSLAN ABDULLAEV")).toBeInTheDocument();
    expect(screen.getByText(/also recorded as R\. ABDULLAYEV/)).toBeInTheDocument();
    expect(screen.getByText(/\(new\) \(current\)/)).toBeInTheDocument();
    expect(screen.getByText(/returned under the same name/)).toBeInTheDocument();
    expect(screen.getByText("322")).toBeInTheDocument();
    expect(screen.getByText("320")).toBeInTheDocument();
  });

  test("the board block shows what the other system says, and never a phone number", async () => {
    // The one screen where an administrator can see both systems side by side
    // and notice they disagree. The board row carries a driver's phone; this
    // panel has no use for it and must not publish it.
    vi.spyOn(api, "getPersonIdentity").mockResolvedValue({
      id: 7,
      displayName: "JOHN SMITH",
      mergedFrom: [],
      groups: [],
      units: [{ id: 1, unitNumber: "001", fleetType: "company", seat: 1, startedAt: "2026-09-01T00:00:00Z", endedAt: null }],
      board: [{
        rowKey: "001|JOHNSMITH", truck: "001", trailer: "T-118", status: "HOME",
        etaText: "Home until Friday", dispatcher: "Ann",
        linkSource: "board", linkConfidence: 95, present: true,
        lastSeenAt: "2026-09-12T10:00:00Z",
      }],
    });
    render(<PersonIdentityPanel personId={7} />);

    expect(await screen.findByText(/Dispatcher board/)).toBeInTheDocument();
    expect(screen.getByText("T-118")).toBeInTheDocument();
    expect(screen.getByText(/Home until Friday/)).toBeInTheDocument();
    expect(screen.getByText(/linked automatically \(95%\)/)).toBeInTheDocument();
    // A truck is (fleet, number, seat) — the number alone is not unique.
    expect(screen.getByText(/Company/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\d{10}/);
  });

  test("a driver with no board row shows no board block at all", async () => {
    vi.spyOn(api, "getPersonIdentity").mockResolvedValue({
      id: 8, displayName: "MARIA GARCIA", mergedFrom: [], groups: [], units: [], board: [],
    });
    render(<PersonIdentityPanel personId={8} />);
    expect(await screen.findByText("MARIA GARCIA")).toBeInTheDocument();
    expect(screen.queryByText(/Dispatcher board/)).toBeNull();
  });
});
