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

  test("a truck shows its fleet, and the removed board block does not come back", async () => {
    // A truck is (fleet, number, seat) — the number alone is not unique. The
    // Dispatcher Board was removed in October 2026; an older server still
    // sending a `board` array must not bring its block (or a phone) back.
    vi.spyOn(api, "getPersonIdentity").mockResolvedValue({
      id: 7,
      displayName: "JOHN SMITH",
      mergedFrom: [],
      groups: [],
      units: [{ id: 1, unitNumber: "001", fleetType: "company", seat: 1, startedAt: "2026-09-01T00:00:00Z", endedAt: null }],
      board: [{ rowKey: "001|JOHNSMITH", truck: "001", trailer: "T-118", status: "HOME" }],
    });
    render(<PersonIdentityPanel personId={7} />);

    expect(await screen.findByText("JOHN SMITH")).toBeInTheDocument();
    expect(screen.getByText(/Company/)).toBeInTheDocument();
    expect(screen.queryByText(/Dispatcher board/)).toBeNull();
    expect(screen.queryByText("T-118")).toBeNull();
  });
});
