/**
 * Design tokens — TASK-54.
 *
 * Single source of truth for the colour palette the client UI
 * uses. Every token is a plain hex string so the contrast test
 * (`src/client/a11y/contrast.test.ts`) can compute the WCAG ratio
 * without pulling in a CSS parser.
 *
 * The `CONTRAST_PAIRS` table lists every foreground/background
 * combination the UI actually renders. The contrast test asserts
 * each pair clears WCAG AA (4.5:1 for body text, 3:1 for large
 * text / UI borders).
 */

/** The Drift colour palette. */
export const THEME = {
  /** Page background (the void behind the canvas). */
  bg: "#05060a",
  /** Panel / modal surface. */
  panel: "#0b1018",
  /** Raised surface (menu rows, chips). */
  surface: "#141b26",
  /** Primary body text. */
  text: "#e6edf3",
  /** Secondary text (labels, footers). */
  textDim: "#a8b6c6",
  /** Primary accent (cyan). */
  accent: "#7be5ff",
  /** Secondary accent (amber). */
  warn: "#ffb84d",
  /** Danger / damage. */
  danger: "#f85149",
  /** Success / friendly. */
  success: "#7ee787",
  /** Hairline borders (≥ 3:1 against both surfaces). */
  border: "#526278",
} as const;

/** A named token pair whose contrast ratio is asserted by the test. */
export interface ContrastPair {
  /** Foreground token name. */
  readonly fg: keyof typeof THEME;
  /** Background token name. */
  readonly bg: keyof typeof THEME;
  /**
   * Minimum ratio the pair must clear.
   * - `4.5` — WCAG AA for normal text.
   * - `3` — WCAG AA for large text (≥ 18.66 px bold / 24 px) and
   *   for non-text UI components (borders, focus rings).
   */
  readonly min: number;
  /** Human-readable description (used in the failure message). */
  readonly label: string;
}

/**
 * Every foreground/background combination the UI renders.
 *
 * Kept explicit (rather than "all pairs") so the test asserts
 * the pairs that matter — a full cross-product would include
 * nonsense combinations (e.g. danger text on danger background)
 * that the UI never renders.
 */
export const CONTRAST_PAIRS: readonly ContrastPair[] = [
  { fg: "text", bg: "bg", min: 4.5, label: "body text on the page background" },
  { fg: "text", bg: "panel", min: 4.5, label: "body text on a panel" },
  { fg: "text", bg: "surface", min: 4.5, label: "body text on a raised surface" },
  { fg: "textDim", bg: "bg", min: 4.5, label: "secondary text on the page background" },
  { fg: "textDim", bg: "panel", min: 4.5, label: "secondary text on a panel" },
  { fg: "textDim", bg: "surface", min: 4.5, label: "secondary text on a raised surface" },
  { fg: "accent", bg: "bg", min: 4.5, label: "accent text on the page background" },
  { fg: "accent", bg: "panel", min: 4.5, label: "accent text on a panel" },
  { fg: "warn", bg: "bg", min: 4.5, label: "warning text on the page background" },
  { fg: "warn", bg: "panel", min: 4.5, label: "warning text on a panel" },
  { fg: "danger", bg: "bg", min: 4.5, label: "danger text on the page background" },
  { fg: "danger", bg: "panel", min: 4.5, label: "danger text on a panel" },
  { fg: "success", bg: "bg", min: 4.5, label: "success text on the page background" },
  { fg: "success", bg: "panel", min: 4.5, label: "success text on a panel" },
  { fg: "border", bg: "panel", min: 3, label: "panel border against the panel surface" },
  { fg: "border", bg: "bg", min: 3, label: "panel border against the page background" },
];
