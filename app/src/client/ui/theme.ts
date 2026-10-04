/**
 * Design tokens (TASK-54): the single source of truth for the UI's
 * text/background color pairs. Components keep their inline styles; the
 * tokens mirror the palette in use so the contrast test can compute WCAG
 * ratios from ONE place.
 *
 * WCAG AA (per the TASK-54 spec): every text/background token pair must
 * reach a 4.5:1 contrast ratio. `theme.contrast.test.ts` asserts all
 * pairs in TOKEN_PAIRS pass.
 */

/** Opaque equivalent of the panel background rgba(13,17,26,0.96) over the app bg. */
export const PANEL_SOLID = '#0d111a';

export const theme = {
  /** App background (the canvas letterbox behind the HUD). */
  bg: '#0b0e14',
  /** The solid panel background (charts, menus, panels). */
  panel: PANEL_SOLID,
  /** Raised surfaces (buttons at rest). */
  surface: '#1d2739',
  /** Panel borders / unselected strokes (not a text color — no pair). */
  border: '#2a3346',
  /** Primary text. */
  text: '#d6deeb',
  /** Secondary text (hints, mono readouts). */
  textMuted: '#8b97ab',
  /** Accent (links, focus, telemetry). */
  accent: '#67e8f9',
  /** Success / GO states. */
  success: '#4ade80',
  /** Warnings. */
  warning: '#f59e0b',
  /** Dangers / critical. */
  danger: '#f87171',
} as const;

/** Every text/background token pair the UI actually ships. */
export const TOKEN_PAIRS: ReadonlyArray<{ name: string; fg: string; bg: string }> = [
  { name: 'primary text on background', fg: theme.text, bg: theme.bg },
  { name: 'primary text on panel', fg: theme.text, bg: theme.panel },
  { name: 'primary text on surface', fg: theme.text, bg: theme.surface },
  { name: 'muted text on background', fg: theme.textMuted, bg: theme.bg },
  { name: 'muted text on panel', fg: theme.textMuted, bg: theme.panel },
  { name: 'accent on background', fg: theme.accent, bg: theme.bg },
  { name: 'accent on panel', fg: theme.accent, bg: theme.panel },
  { name: 'success on background', fg: theme.success, bg: theme.bg },
  { name: 'warning on background', fg: theme.warning, bg: theme.bg },
  { name: 'danger on background', fg: theme.danger, bg: theme.bg },
  { name: 'danger on panel', fg: theme.danger, bg: theme.panel },
];

/** WCAG 2.x relative luminance of a #rrggbb hex color. */
export function relativeLuminance(hex: string): number {
  const value = hex.replace('#', '');
  const channel = (i: number): number => {
    const c = parseInt(value.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

/** WCAG contrast ratio between two hex colors (1..21). */
export function contrastRatio(fg: string, bg: string): number {
  const a = relativeLuminance(fg);
  const b = relativeLuminance(bg);
  const [lighter, darker] = a >= b ? [a, b] : [b, a];
  return (lighter + 0.05) / (darker + 0.05);
}

/** The WCAG AA threshold for normal text (spec: 4.5:1). */
export const AA_NORMAL_TEXT = 4.5;
