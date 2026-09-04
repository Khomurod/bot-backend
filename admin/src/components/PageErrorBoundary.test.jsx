/**
 * The regression test for the production symptom: "the same message appears for
 * Driver Groups, Mileage Bonuses and other sections".
 *
 * Only ONE section was actually broken. The single shared boundary latched on
 * the first throw, so every section opened afterwards rendered the failure text
 * without ever being mounted. The tests below pin the two behaviours that fix
 * it — a failure stays inside its own section, and navigating to another
 * section really renders that section — plus the classified wording, since a
 * message that blames a deploy for a ReferenceError is what hid this bug.
 */
import React from "react";
import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import PageErrorBoundary from "./PageErrorBoundary";

/** A section that throws the error the incident reported. */
function BrokenSection() {
  throw new ReferenceError("getDaysUntilBirthday is not defined");
}

function HealthySection({ name }) {
  return <div>{name} loaded</div>;
}

let consoleError;

beforeEach(() => {
  // React logs every caught error; the boundary logs its own line. Neither is
  // the subject of these tests.
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  consoleError.mockRestore();
});

describe("a broken section", () => {
  test("shows the real cause instead of blaming a deploy", () => {
    render(
      <PageErrorBoundary resetKey="groups">
        <BrokenSection />
      </PageErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText(/this section has a bug/i)).toBeInTheDocument();
    expect(screen.getByText(/getDaysUntilBirthday is not defined/)).toBeInTheDocument();
    expect(screen.queryByText(/a new version may have been deployed/i)).toBeNull();
  });

  test("names the failing section in the log so a report can be matched to a stack", () => {
    render(
      <PageErrorBoundary resetKey="mileage_bonus">
        <BrokenSection />
      </PageErrorBoundary>,
    );
    const logged = consoleError.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logged).toContain('section "mileage_bonus" failed');
  });
});

describe("the other sections", () => {
  test("navigating to another section renders it, rather than the previous failure", () => {
    // THE BUG: with a latching boundary this second render kept showing the
    // failure text and never mounted the healthy section.
    const { rerender } = render(
      <PageErrorBoundary resetKey="groups">
        <BrokenSection />
      </PageErrorBoundary>,
    );
    expect(screen.getByText(/this section has a bug/i)).toBeInTheDocument();

    rerender(
      <PageErrorBoundary resetKey="mileage_bonus">
        <HealthySection name="Mileage Bonuses" />
      </PageErrorBoundary>,
    );
    expect(screen.getByText("Mileage Bonuses loaded")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("switching quickly between several sections keeps working", () => {
    const { rerender } = render(
      <PageErrorBoundary resetKey="groups">
        <BrokenSection />
      </PageErrorBoundary>,
    );
    for (const name of ["Broadcast", "Home Time", "Live Locations"]) {
      rerender(
        <PageErrorBoundary resetKey={name}>
          <HealthySection name={name} />
        </PageErrorBoundary>,
      );
      expect(screen.getByText(`${name} loaded`)).toBeInTheDocument();
    }
    // …and a section that breaks later is still contained.
    rerender(
      <PageErrorBoundary resetKey="questions">
        <BrokenSection />
      </PageErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });
});

describe("retrying", () => {
  test("Try again remounts the section, so a transient failure recovers", async () => {
    // Controlled from the test rather than by a render counter: React re-renders
    // a failed subtree while collecting the stack, so "throw only on the first
    // render" would never reach the failure UI at all.
    const control = { throwing: true, mounts: 0 };

    function FlakySection() {
      React.useEffect(() => { control.mounts += 1; }, []);
      if (control.throwing) throw new TypeError("Cannot read properties of undefined (reading 'map')");
      return <div>Home Time loaded</div>;
    }

    render(
      <PageErrorBoundary resetKey="home_time">
        <FlakySection />
      </PageErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(control.mounts).toBe(0);

    control.throwing = false;
    await userEvent.click(screen.getByRole("button", { name: /try again/i }));

    expect(screen.getByText("Home Time loaded")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(control.mounts).toBe(1);
  });
});

describe("a healthy section", () => {
  test("renders untouched", () => {
    render(
      <PageErrorBoundary resetKey="settings">
        <HealthySection name="Settings" />
      </PageErrorBoundary>,
    );
    expect(screen.getByText("Settings loaded")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
