/**
 * Ship catalog — the canonical v1 ship classes.
 *
 * The three ships defined here are the source of truth for *every*
 * downstream consumer:
 *
 *   - Server flight model (TASK-22) reads `maxVelocity`, `acceleration`,
 *     `turnRate`, `mass`, `cargoSlots`, `weaponMounts`, `shieldCapacity`,
 *     `hull`, `repairCostPerPoint` to drive the deterministic tick.
 *   - Server weapons (TASK-43) reads `weaponMounts` to determine laser /
 *     missile capability for a given ship class.
 *   - Server AI roster (TASK-45) reads `SHIP_CLASSES` to pick a class
 *     per AI spawn — picking from this same map keeps stats balanced.
 *   - Client ship HUD (TASK-51) reads `shieldCapacity`, `hull`, and
 *     `cargoSlots` to render the cockpit gauges.
 *   - Client dock UI (TASK-20) reads `name`, `description`, `price`,
 *     and `cargoSlots` to render the buy screen.
 *   - Persistent livery (TASK-21) reads `liverySlots` (= 3 paint zones:
 *     hull, accent, trim).
 *
 * Everything in this module is pure data + pure helpers — no imports,
 * no `Date.now`, no `Math.random`. Two clients reading the same module
 * get the same numbers.
 *
 * ## Number rationale
 *
 * Stats were chosen so the three classes have a clear role triangle:
 *
 *   scout      — middle speed, middle cargo, single laser, no missiles,
 *                free starter. Designed for learning the systems without
 *                being dominated by late-game content.
 *   freighter  — *lowest* speed (60 u/s) but the *largest* cargo hold
 *                (12 slots / 240 u mass) and the toughest hull (200).
 *                The endgame trade-and-mine ship: you fly slow but you
 *                out-haul an interceptor 6:1.
 *   interceptor — *highest* speed (180 u/s), the only ship with missiles
 *                (4 mounts) and a second laser (2 mounts). Smaller
 *                cargo (2 slots) and lighter hull (80) reflect the
 *                glass-cannon trade-off. The combat ship.
 *
 * Price ordering: scout (0, starter) < interceptor (2500) < freighter
 * (4000). Cheaper combat than trade, so a new player can choose either
 * path early without feeling priced out of combat.
 *
 * @see TASK-19 for the full acceptance criteria.
 * @see ./random.ts for the seed-derived primitives this module does
 *      *not* depend on (it is intentionally pure-data).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The three v1 ship class ids. Stable across all client/server code. */
export type ShipClassId = "scout" | "freighter" | "interceptor";

/** All class ids in display order (also the order the dock UI iterates). */
export const SHIP_CLASS_IDS: readonly ShipClassId[] = [
  "scout",
  "freighter",
  "interceptor",
] as const;

/**
 * Weapon mounts a ship class supports.
 *
 * `laser` is 1 (single hardpoint) or 2 (twin-linked for the interceptor
 * — a single fire key fires both simultaneously, doubling DPS). `missiles`
 * is 0 (scout / freighter, missile-less) or 4 (interceptor — 4-cell
 * missile bay). Future classes (e.g. corvette with 6 missiles) would
 * extend this contract; the spec only requires the v1 set today.
 */
export interface WeaponMounts {
  /** Number of laser hardpoints: 1 or 2. */
  laser: 1 | 2;
  /** Number of missile bays: 0 or 4. */
  missiles: 0 | 4;
}

/**
 * One ship class — the full data row that every downstream module reads.
 *
 * Field-by-field justification:
 *
 *   - `id`             — the stable key. MUST equal the `SHIP_CLASS_IDS`
 *                        entry it lives under (asserted in tests).
 *   - `name`           — display name for the dock UI / HUD labels.
 *   - `description`    — short blurb shown on the dock purchase panel.
 *   - `mass`           — mass in arbitrary sim units. Drives momentum
 *                        (`a = F / m`) in the flight model. Bigger mass
 *                        means slower acceleration for the same engine.
 *   - `maxVelocity`    — top speed in arbitrary sim units per second.
 *                        Hard cap; the flight model never exceeds this.
 *   - `acceleration`   — engine thrust divided by mass, in u/s². Drives
 *                        how quickly a ship reaches `maxVelocity`.
 *   - `turnRate`       — angular speed in radians per second. Higher =
 *                        more nimble. 0.4 (freighter) is intentionally
 *                        sluggish; 1.2 (interceptor) feels arcade.
 *   - `cargoSlots`     — number of inventory slots for ore / goods. 1
 *                        for a single-item hauler (future), 4/12/2 for
 *                        the v1 trio. Always ≥ 1 (asserted in tests).
 *   - `maxWeight`      — maximum cargo weight in sim units. Prevents
 *                        players from overloading a scout with 12
 *                        freighter-class items.
 *   - `weaponMounts`   — laser + missile capacity. See `WeaponMounts`.
 *   - `shieldCapacity` — full-shield HP. Shield recharges after a few
 *                        seconds out of combat (TASK-42 / TASK-23).
 *   - `hull`           — full-hull HP. Once hull == 0 the ship is
 *                        destroyed (TASK-49).
 *   - `repairCostPerPoint` — credits to restore 1 HP of hull *or*
 *                        shield at a dock (TASK-23). Interceptors are
 *                        expensive to maintain because their combat
 *                        role causes more damage.
 *   - `price`          — dock purchase price in credits. The starter
 *                        scout is 0 (TASK-20 mints it for free on
 *                        callsign claim).
 *   - `liverySlots`    — number of paint zones (TASK-21). All three v1
 *                        ships support 3 paint zones (hull / accent /
 *                        trim); future classes could ship with more.
 */
export interface ShipClass {
  id: ShipClassId;
  name: string;
  description: string;
  /** Mass in arbitrary sim units. Positive finite. */
  mass: number;
  /** Max speed in arbitrary sim units per second. Positive finite. */
  maxVelocity: number;
  /** Acceleration in arbitrary sim units per second squared. Positive finite. */
  acceleration: number;
  /** Angular speed in radians per second. Positive finite. */
  turnRate: number;
  /** Number of cargo slots. Always ≥ 1. */
  cargoSlots: number;
  /** Maximum cargo weight in sim units. Positive finite. */
  maxWeight: number;
  /** Weapon hardpoint configuration. */
  weaponMounts: WeaponMounts;
  /** Full shield HP. Positive finite. */
  shieldCapacity: number;
  /** Full hull HP. Positive finite. */
  hull: number;
  /** Credits to repair 1 HP of hull or shield at a dock. Positive finite. */
  repairCostPerPoint: number;
  /** Dock purchase price in credits. 0 for the starter scout. Non-negative finite. */
  price: number;
  /** Number of paint zones. Always 3 for v1 (TASK-21). */
  liverySlots: number;
}

/** Numeric stat keys used by `compareShips()` for UI sorting. */
export type ShipStatKey =
  | "mass"
  | "maxVelocity"
  | "acceleration"
  | "turnRate"
  | "cargoSlots"
  | "maxWeight"
  | "shieldCapacity"
  | "hull"
  | "repairCostPerPoint"
  | "price"
  | "liverySlots";

// ---------------------------------------------------------------------------
// Data — three classes
// ---------------------------------------------------------------------------

/**
 * The scout — the free starter ship granted on callsign claim (TASK-20).
 *
 *   mass=20, maxVelocity=120, acceleration=40, turnRate=0.8,
 *   cargoSlots=4, maxWeight=40, 1 laser, 0 missiles,
 *   shield=50, hull=100, repair=1, price=0, liverySlots=3.
 *
 * The middle of the triangle: not the fastest, not the toughest, not
 * the biggest cargo hold. Free so every player starts in one.
 */
const SCOUT: ShipClass = {
  id: "scout",
  name: "Scout",
  description: "Light, agile starter ship. Balanced for exploration and learning the systems.",
  mass: 20,
  maxVelocity: 120,
  acceleration: 40,
  turnRate: 0.8,
  cargoSlots: 4,
  maxWeight: 40,
  weaponMounts: { laser: 1, missiles: 0 },
  shieldCapacity: 50,
  hull: 100,
  repairCostPerPoint: 1,
  price: 0,
  liverySlots: 3,
};

/**
 * The freighter — the endgame trade-and-mine ship.
 *
 *   mass=120, maxVelocity=60, acceleration=12, turnRate=0.4,
 *   cargoSlots=12, maxWeight=240, 1 laser, 0 missiles,
 *   shield=80, hull=200, repair=2, price=4000, liverySlots=3.
 *
 * Slowest (60 u/s), bulkiest cargo (12 slots / 240 u), toughest hull
 * (200). Only one laser, no missiles — its weapon is "outlast the
 * pirate in a chase." At 4000 credits it is the most expensive ship,
 * reflecting the late-game trade progression.
 */
const FREIGHTER: ShipClass = {
  id: "freighter",
  name: "Freighter",
  description: "Slow but tough hauler. Maximum cargo and the sturdiest hull in the catalog.",
  mass: 120,
  maxVelocity: 60,
  acceleration: 12,
  turnRate: 0.4,
  cargoSlots: 12,
  maxWeight: 240,
  weaponMounts: { laser: 1, missiles: 0 },
  shieldCapacity: 80,
  hull: 200,
  repairCostPerPoint: 2,
  price: 4000,
  liverySlots: 3,
};

/**
 * The interceptor — the glass-cannon combat ship.
 *
 *   mass=30, maxVelocity=180, acceleration=70, turnRate=1.2,
 *   cargoSlots=2, maxWeight=20, 2 lasers, 4 missiles,
 *   shield=40, hull=80, repair=3, price=2500, liverySlots=3.
 *
 * Fastest (180 u/s), only ship with missiles (4-cell bay), twin-linked
 * lasers (2 hardpoints fired simultaneously). Smallest cargo (2 slots)
 * and lightest hull (80) — the trade-off for the damage output.
 * Repairs are the most expensive per HP because combat is its role.
 */
const INTERCEPTOR: ShipClass = {
  id: "interceptor",
  name: "Interceptor",
  description:
    "Fastest ship in the catalog. Twin lasers and a 4-cell missile bay for serious combat.",
  mass: 30,
  maxVelocity: 180,
  acceleration: 70,
  turnRate: 1.2,
  cargoSlots: 2,
  maxWeight: 20,
  weaponMounts: { laser: 2, missiles: 4 },
  shieldCapacity: 40,
  hull: 80,
  repairCostPerPoint: 3,
  price: 2500,
  liverySlots: 3,
};

/**
 * The full ship catalog. Keyed by `ShipClassId` so consumers can do
 * `SHIP_CLASSES[id]` and get a `ShipClass` back. Insertion order matches
 * `SHIP_CLASS_IDS` for stable iteration.
 *
 * Invariants (asserted in tests):
 *   - Exactly 3 classes are present (matches `SHIP_CLASS_IDS.length`).
 *   - `ShipClass.id === key` for every entry (no copy-paste typos).
 *   - All numeric stats are positive finite numbers.
 *   - `cargoSlots >= 1` for every class.
 *   - Balance: freighter has the most cargo; interceptor has the
 *     highest speed and the only missile battery; prices ascend
 *     scout (0) < interceptor (2500) < freighter (4000).
 */
export const SHIP_CLASSES: Readonly<Record<ShipClassId, ShipClass>> = {
  scout: SCOUT,
  freighter: FREIGHTER,
  interceptor: INTERCEPTOR,
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Look up a ship class by id. Throws a typed `Error` with a useful
 * message when the id is not one of the three known v1 classes — the
 * server flight model and dock UI use this as their single entry point
 * so they fail loudly instead of silently rendering `undefined`.
 */
export function shipStats(id: ShipClassId): ShipClass {
  const entry = SHIP_CLASSES[id];
  if (!entry) {
    throw new Error(`shipStats: unknown ship class id "${id}"`);
  }
  return entry;
}

/**
 * Total number of weapon hardpoints (laser + missiles) for a class.
 * Used by the combat HUD to display the row count of weapon cards.
 */
export function totalWeaponCount(id: ShipClassId): number {
  const cls = shipStats(id);
  return cls.weaponMounts.laser + cls.weaponMounts.missiles;
}

/**
 * Look up the dock purchase price for a class. Convenience for the
 * dock UI; equivalent to `shipStats(id).price` but lets call sites
 * say "the price for the interceptor" without mentioning stats.
 */
export function shipPrice(id: ShipClassId): number {
  return shipStats(id).price;
}

/**
 * Compare two ship classes by a single numeric stat key. Returns a
 * negative number if `a < b`, positive if `a > b`, zero if equal.
 *
 * Use from the dock UI to sort a ship-list table by, e.g., price or
 * cargo slots. Returns `NaN` (matching `Array.prototype.sort` semantics)
 * if `key` is not a valid `ShipStatKey` — the caller is expected to
 * pass a valid key.
 */
export function compareShips(a: ShipClassId, b: ShipClassId, key: ShipStatKey): number {
  const av = shipStats(a)[key];
  const bv = shipStats(b)[key];
  return av - bv;
}
