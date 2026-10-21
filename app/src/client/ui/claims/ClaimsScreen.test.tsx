/**
 * ClaimsScreen component unit tests (TASK-56).
 *
 * Exercises the React surface against a real DOM (happy-dom) with a
 * stubbed fetcher so the four key UI states are pinned:
 *
 *   1. Title + disabled Claim button render on mount.
 *   2. A too-short input → invalid chip, no server round-trip.
 *   3. An available server response → green chip + Claim enabled.
 *   4. A taken server response → red chip + Claim disabled.
 *   5. Expired-session banner renders when the host passes a callsign.
 *   6. Debounced typing: only the final value goes to the server.
 *   7. The Skip-intro button collapses the auto-advance timer.
 *   8. Submit fires `onClaim` with the validated callsign.
 *
 * The headline two-player e2e is in `tests/e2e/first-launch.spec.ts`
 * — this file is the React-side coverage.
 *
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";

import { ClaimsScreen } from "./ClaimsScreen.js";

declare global {
  // React 19's act() requires this flag when run inside a test runner.

  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Helper: render the panel synchronously and return the DOM root. */
function renderPanel(node: ReactNode): HTMLElement {
  act(() => {
    root.render(node);
  });
  return container;
}

/** Helper: fire an input change event on a test-id'd input. */
function setInputValue(testId: string, value: string): void {
  const el = container.querySelector<HTMLInputElement>(`[data-testid="${testId}"]`);
  if (!el) throw new Error(`no input for ${testId}`);
  const proto = Object.getPrototypeOf(el);
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

/** Helper: read the chip's `data-state` attribute. */
function chipState(): string | null {
  return (
    container.querySelector('[data-testid="drift-claims-chip"]')?.getAttribute("data-state") ?? null
  );
}

/** Helper: read the Claim button's disabled flag. */
function isClaimDisabled(): boolean {
  const button = container.querySelector<HTMLButtonElement>(
    '[data-testid="drift-claims-claim-button"]',
  );
  return button === null ? true : button.disabled;
}

/** Helper: click the submit button. */
function clickClaim(): void {
  const button = container.querySelector<HTMLButtonElement>(
    '[data-testid="drift-claims-claim-button"]',
  );
  if (!button) throw new Error("no claim button");
  act(() => {
    button.click();
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ClaimsScreen — static render", () => {
  it("renders the title and the disabled Claim button on mount", () => {
    renderPanel(
      <ClaimsScreen
        onClaim={async () => {}}
        claiming={false}
        fetcher={async () => new Response()}
      />,
    );
    expect(container.querySelector('[data-testid="drift-claims-title"]')?.textContent).toBe(
      "DRIFT",
    );
    expect(isClaimDisabled()).toBe(true);
  });

  it("shows the intro copy on mount", () => {
    renderPanel(
      <ClaimsScreen
        onClaim={async () => {}}
        claiming={false}
        fetcher={async () => new Response()}
      />,
    );
    expect(
      container.querySelector('[data-testid="drift-claims-intro-slide"]')?.textContent,
    ).toMatch(/living galaxy/);
  });
});

describe("ClaimsScreen — validation states", () => {
  it("flags a too-short input with the invalid chip state and never hits the server", async () => {
    const fetcher = vi.fn();
    renderPanel(
      <ClaimsScreen
        onClaim={async () => {}}
        claiming={false}
        fetcher={fetcher as unknown as typeof fetch}
      />,
    );
    setInputValue("drift-claims-callsign-input", "ab");
    // Allow the 500 ms debounce + the format check to run.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(chipState()).toBe("invalid");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("enables the Claim button after a server `available` probe", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            callsign: "Pilot-7",
            normalized: "pilot-7",
            available: true,
            reason: "available",
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
    );
    renderPanel(
      <ClaimsScreen
        onClaim={async () => {}}
        claiming={false}
        fetcher={fetcher as unknown as typeof fetch}
      />,
    );
    setInputValue("drift-claims-callsign-input", "Pilot-7");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });
    expect(chipState()).toBe("available");
    expect(isClaimDisabled()).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect((fetcher.mock.calls[0] as unknown as [string])[0]).toMatch(/callsign=Pilot-7/);
  });

  it("keeps the Claim button disabled after a server `taken` probe", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            callsign: "Taken-1",
            normalized: "taken-1",
            available: false,
            reason: "taken",
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
    );
    renderPanel(
      <ClaimsScreen
        onClaim={async () => {}}
        claiming={false}
        fetcher={fetcher as unknown as typeof fetch}
      />,
    );
    setInputValue("drift-claims-callsign-input", "Taken-1");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });
    expect(chipState()).toBe("taken");
    expect(isClaimDisabled()).toBe(true);
  });
});

describe("ClaimsScreen — UI affordances", () => {
  it("renders the expired-session banner when the host supplies a callsign", () => {
    renderPanel(
      <ClaimsScreen
        onClaim={async () => {}}
        claiming={false}
        expiredCallsign="OldPilot"
        fetcher={async () => new Response()}
      />,
    );
    const notice = container.querySelector('[data-testid="drift-claims-expired-notice"]');
    expect(notice?.textContent).toMatch(/Your session expired/);
    expect(notice?.textContent).toMatch(/OldPilot/);
  });

  it("debounces a typing burst so only the final value goes to the server", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            callsign: "Pilot-99",
            normalized: "pilot-99",
            available: true,
            reason: "available",
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
    );
    renderPanel(
      <ClaimsScreen
        onClaim={async () => {}}
        claiming={false}
        fetcher={fetcher as unknown as typeof fetch}
      />,
    );
    setInputValue("drift-claims-callsign-input", "P");
    setInputValue("drift-claims-callsign-input", "Pi");
    setInputValue("drift-claims-callsign-input", "Pilot-9");
    setInputValue("drift-claims-callsign-input", "Pilot-99");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect((fetcher.mock.calls[0] as unknown as [string])[0]).toMatch(/callsign=Pilot-99/);
  });

  it("the Skip-intro button collapses the auto-advance timer", async () => {
    renderPanel(
      <ClaimsScreen
        onClaim={async () => {}}
        claiming={false}
        fetcher={async () => new Response()}
      />,
    );
    const skip = container.querySelector<HTMLButtonElement>(
      '[data-testid="drift-claims-intro-skip"]',
    );
    if (!skip) throw new Error("no skip button");
    act(() => skip.click());
    const before = container.querySelector('[data-testid="drift-claims-intro-slide"]')?.textContent;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_000);
    });
    expect(container.querySelector('[data-testid="drift-claims-intro-slide"]')?.textContent).toBe(
      before,
    );
  });

  it("fires onClaim with the validated callsign on submit", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            callsign: "Submit-Me",
            normalized: "submit-me",
            available: true,
            reason: "available",
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
    );
    const onClaim = vi.fn(async () => {});
    renderPanel(
      <ClaimsScreen
        onClaim={onClaim}
        claiming={false}
        fetcher={fetcher as unknown as typeof fetch}
      />,
    );
    setInputValue("drift-claims-callsign-input", "Submit-Me");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });
    expect(isClaimDisabled()).toBe(false);
    clickClaim();
    expect(onClaim).toHaveBeenCalledWith({ callsign: "Submit-Me" });
  });

  it("disables the Claim button while the host's claim POST is in flight", () => {
    renderPanel(
      <ClaimsScreen
        onClaim={async () => {
          // never resolves — simulates an in-flight POST
          await new Promise(() => {});
        }}
        claiming={true}
        expiredCallsign={null}
        fetcher={async () =>
          new Response(
            JSON.stringify({
              callsign: "Pilot-7",
              normalized: "pilot-7",
              available: true,
              reason: "available",
            }),
            { headers: { "Content-Type": "application/json" } },
          )
        }
      />,
    );
    // Even though the chip says `available`, the `claiming` prop
    // forces the button into the disabled state.
    setInputValue("drift-claims-callsign-input", "Pilot-7");
    void vi.advanceTimersByTime(700); // ignore the promise
    expect(isClaimDisabled()).toBe(true);
  });
});
