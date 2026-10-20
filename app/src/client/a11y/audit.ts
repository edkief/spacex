/**
 * Accessible-name audit — TASK-54.
 *
 * Walks a DOM subtree and reports every *interactive* element
 * that has no accessible name. The spec's acceptance criterion is
 * "every interactive element has an accessible name (aria-label or
 * visible label)", so this is the reusable checker behind both the
 * unit test (static markup of each screen) and the e2e test (the
 * live DOM).
 *
 * The name resolution follows the HTML-AAM rules closely enough
 * for a UI audit:
 *
 *   1. `aria-labelledby` → the referenced elements' text,
 *   2. `aria-label`,
 *   3. the element's own text content (buttons / menu items),
 *   4. `title`,
 *   5. for form controls: the associated `<label>` / `placeholder`.
 */

/** The selectors that count as "interactive". */
export const INTERACTIVE_SELECTOR = [
  "button",
  "input",
  "select",
  "textarea",
  "a[href]",
  "[role='button']",
  "[role='menuitem']",
  "[role='menuitemcheckbox']",
  "[role='menuitemradio']",
  "[role='option']",
  "[role='switch']",
  "[role='tab']",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/** The result of one audit: the offending elements + a reason. */
export interface UnlabeledElement {
  /** A short descriptor (tag + test id + role) for the message. */
  readonly description: string;
  /** Why the element was considered unlabeled. */
  readonly reason: string;
}

/** The minimal element surface the audit needs (DOM or a test double). */
export interface AuditElement {
  readonly tagName: string;
  readonly textContent: string | null;
  getAttribute(name: string): string | null;
  querySelectorAll(selectors: string): ArrayLike<AuditElement>;
  /** Optional DOM `closest` (used to detect aria-hidden ancestors). */
  closest?(selectors: string): AuditElement | null;
}

/** The minimal document surface the audit needs. */
export interface AuditRoot extends AuditElement {
  querySelectorAll(selectors: string): ArrayLike<AuditElement>;
  getElementById(id: string): AuditElement | null;
}

/** Resolve the accessible name of one element. */
export function accessibleName(el: AuditElement, root?: AuditRoot): string {
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy !== null && labelledBy.trim() !== "") {
    const parts: string[] = [];
    for (const id of labelledBy.split(/\s+/)) {
      const target = root?.getElementById(id) ?? null;
      if (target !== null && target.textContent !== null) parts.push(target.textContent.trim());
    }
    if (parts.join(" ").trim() !== "") return parts.join(" ").trim();
  }
  const ariaLabel = el.getAttribute("aria-label");
  if (ariaLabel !== null && ariaLabel.trim() !== "") return ariaLabel.trim();
  const text = (el.textContent ?? "").trim();
  if (text !== "") return text;
  const title = el.getAttribute("title");
  if (title !== null && title.trim() !== "") return title.trim();
  const placeholder = el.getAttribute("placeholder");
  if (placeholder !== null && placeholder.trim() !== "") return placeholder.trim();
  return "";
}

/** A short human-readable descriptor for an element. */
function describe(el: AuditElement): string {
  const tag = el.tagName.toLowerCase();
  const id = el.getAttribute("data-testid") ?? el.getAttribute("id");
  const role = el.getAttribute("role");
  return `${tag}${id !== null ? `[${id}]` : ""}${role !== null ? `(role=${role})` : ""}`;
}

/**
 * Audit a subtree and return every interactive element without an
 * accessible name. An empty array means the subtree passes.
 */
export function findUnlabeledInteractive(root: AuditRoot): UnlabeledElement[] {
  const problems: UnlabeledElement[] = [];
  const elements = root.querySelectorAll(INTERACTIVE_SELECTOR);
  for (let i = 0; i < elements.length; i++) {
    const el = elements[i]!;
    // A hidden input (type=hidden) is not user-interactive.
    const type = el.getAttribute("type");
    if (type === "hidden") continue;
    // `aria-hidden` subtrees are removed from the accessibility tree.
    if (el.getAttribute("aria-hidden") === "true") continue;
    if (el.closest !== undefined && el.closest('[aria-hidden="true"]') !== null) continue;
    if (accessibleName(el, root) === "") {
      problems.push({ description: describe(el), reason: "no accessible name" });
    }
  }
  return problems;
}
