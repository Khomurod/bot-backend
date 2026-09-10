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
});
