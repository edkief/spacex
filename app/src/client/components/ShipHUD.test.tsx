/**
 * ShipHUD (TASK-51) component suite.
 *
 * Renders the assembled ship HUD via `renderToStaticMarkup` and
 * asserts:
 *
 *   - every region renders its slot's data-testid,
 *   - the speed / altitude / vitals / regime formatting matches
 *     the spec (1 decimal m/s, '—' in space, ALT X m on surface,
 *     hull + shield tracks render),
 *   - the docked tag mounts only when the local ship is on a pad,
 *   - the hit-flash flag flips when the controller says so,
 *   - the nav readout math drives the bearing + distance label.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { ShipHUD, type ShipHudSnapshot } from "./ShipHUD.js";
import { HitFlashController } from "../combat/hud/vitals.js";

function makeSnapshot(over: Partial<ShipHudSnapshot> = {}): ShipHudSnapshot {
  return {
    pos: { x: 0, y: 50, z: 0 },
    vel: { x: 0, y: 0, z: 12.4 },
    quat: { x: 0, y: 0, z: 0, w: 1 },
    regime: "atmosphere",
    hull: 80,
    shields: 30,
    onPad: null,
    classId: "scout",
    throttle: 0.5,
    ...over,
  };
}

describe("ShipHUD assembly (TASK-51)", () => {
  it("renders the five regions in their slots", () => {
    const html = renderToStaticMarkup(
      <ShipHUD
        snapshot={makeSnapshot()}
        dockFallback={{
          padId: "PAD-1",
          pos: { x: 100, y: 0, z: 0 },
          stationName: "Hebe",
        }}
        flashController={new HitFlashController()}
      />,
    );
    expect(html).toContain('data-testid="drift-ship-hud"');
    expect(html).toContain('data-testid="drift-ship-speed-readout"');
    expect(html).toContain('data-testid="drift-ship-altitude-readout"');
    expect(html).toContain('data-testid="drift-ship-regime-tag"');
    expect(html).toContain('data-testid="drift-ship-vitals-bar"');
    expect(html).toContain('data-testid="drift-ship-nav-readout"');
  });

  it("formats speed at 1 decimal place", () => {
    const html = renderToStaticMarkup(
      <ShipHUD
        snapshot={makeSnapshot({ vel: { x: 0, y: 0, z: 12.4 } })}
        flashController={new HitFlashController()}
      />,
    );
    expect(html).toContain(">12.4<");
    // Thrust bar carries the positive-throttle flag.
    expect(html).toContain('data-positive="true"');
  });

  it("formats altitude as 'ALT X m' in atmosphere, em-dash in space", () => {
    const atmo = renderToStaticMarkup(
      <ShipHUD
        snapshot={makeSnapshot({ regime: "atmosphere", pos: { x: 0, y: 1234, z: 0 } })}
        flashController={new HitFlashController()}
      />,
    );
    expect(atmo).toContain("ALT 1234 m");
    expect(atmo).toContain('data-regime="ATMOS"');
    expect(atmo).toContain(">ATMOS<");

    const space = renderToStaticMarkup(
      <ShipHUD
        snapshot={makeSnapshot({ regime: "space", pos: { x: 0, y: 9999, z: 0 } })}
        flashController={new HitFlashController()}
      />,
    );
    expect(space).toContain("—");
    expect(space).toContain('data-regime="SPACE"');
    expect(space).toContain(">SPACE<");
  });

  it("renders the vitals bar with hull + shield tracks", () => {
    const html = renderToStaticMarkup(
      <ShipHUD
        snapshot={makeSnapshot({ hull: 50, shields: 25 })}
        flashController={new HitFlashController()}
      />,
    );
    expect(html).toContain('data-testid="drift-ship-shield-bar"');
    expect(html).toContain('data-testid="drift-ship-hull-bar"');
    expect(html).toContain("SHD 25");
    expect(html).toContain("HULL 50");
  });

  it("mounts the docked tag only when on a pad", () => {
    const docked = renderToStaticMarkup(
      <ShipHUD
        snapshot={makeSnapshot({ onPad: "PAD-1" })}
        dockFallback={{ padId: "PAD-1", pos: { x: 0, y: 0, z: 0 }, stationName: "Hebe Station" }}
        flashController={new HitFlashController()}
      />,
    );
    expect(docked).toContain('data-testid="drift-ship-docked-tag"');
    expect(docked).toContain("DOCKED");
    expect(docked).toContain("Hebe Station");
    expect(docked).toContain('data-testid="drift-ship-docked-actions"');

    const empty = renderToStaticMarkup(
      <ShipHUD
        snapshot={makeSnapshot({ onPad: null })}
        flashController={new HitFlashController()}
      />,
    );
    expect(empty).not.toContain('data-testid="drift-ship-docked-tag"');
  });

  it("flips the flash attribute when the HitFlashController is in-window", () => {
    const c = new HitFlashController();
    c.recordSelfHit(Date.now());
    const html = renderToStaticMarkup(<ShipHUD snapshot={makeSnapshot()} flashController={c} />);
    expect(html).toContain('data-flash="active"');
    const idled = renderToStaticMarkup(
      <ShipHUD snapshot={makeSnapshot()} flashController={new HitFlashController()} />,
    );
    expect(idled).toContain('data-flash="idle"');
  });

  it("omits the nav readout when there is no chart or dock target", () => {
    const html = renderToStaticMarkup(
      <ShipHUD snapshot={makeSnapshot()} flashController={new HitFlashController()} />,
    );
    expect(html).not.toContain('data-testid="drift-ship-nav-readout"');
  });

  it("mounts the nav readout when a dock fallback is provided", () => {
    const html = renderToStaticMarkup(
      <ShipHUD
        snapshot={makeSnapshot({
          pos: { x: 0, y: 0, z: 0 },
        })}
        dockFallback={{
          padId: "PAD-1",
          pos: { x: 100, y: 0, z: 0 },
          stationName: "Hebe",
        }}
        flashController={new HitFlashController()}
      />,
    );
    expect(html).toContain('data-testid="drift-ship-nav-readout"');
    expect(html).toContain('data-nav-source="dock"');
    expect(html).toContain("100 m");
  });

  it("renders nothing when the snapshot is null", () => {
    const html = renderToStaticMarkup(
      <ShipHUD snapshot={null} flashController={new HitFlashController()} />,
    );
    expect(html).toBe("");
  });

  it("renders nothing when the HUD is disabled", () => {
    const html = renderToStaticMarkup(
      <ShipHUD
        snapshot={makeSnapshot()}
        flashController={new HitFlashController()}
        enabled={false}
      />,
    );
    expect(html).toBe("");
  });
});
