/**
 * Interaction prompt — TASK-33.
 *
 * Bottom-centre prompt that mounts only when:
 *
 *   - the local entity is a `character` (on-foot mode),
 *   - the player is `online` (so a press hits the server),
 *   - the candidate raycast (3 m forward cone) finds at least one
 *     interactable, and
 *   - the prompt's `(targetId, action)` matches a registry entry.
 *
 * The host (App.tsx) supplies a list of interactables — derived from
 * the renderer-side projection of every `entity_update` entity (the
 * per-character view in TASK-32 + deposit / ship / terminal ids in
 * subsequent tasks). The component re-runs the cone raycast on every
 * snapshot — cheap (≤ 200 entries), no per-frame loop.
 *
 * On `E` press: calls `onInteract(targetId, action)`, which forwards
 * to `DriftClient.sendInteract(targetId, action)` (TASK-33 ships
 * that method alongside this component). The prompt stays visible
 * until either the target leaves the cone (next snapshot picks a
 * different / no target) or the player moves off-foot.
 *
 * TASK-35 re-routing: the registry's `ship` entry fires `action:
 * 'enter'`, which the registry's server dispatch routes through
 * `handleEnterShip`. The client-side path mirrors this: pressing E
 * on a ship target sends `enter_ship` (NOT `interact`), so the
 * server's `handleEnterShip` validation runs with the 5 m radius +
 * ownership check (the in-cone prompt is just a discovery affordance
 * — the player could also walk around to the back of the ship and
 * press E from any direction).
 *
 * Acceptance criteria:
 *
 *   - Prompt visible when a candidate is in range.
 *   - Prompt hidden when nothing is in range (returns null).
 *   - E press calls the onInteract callback exactly once per press.
 *   - Pressing E with no prompt is a no-op.
 *   - Text-input keystrokes are ignored so typing "e" in chat
 *     doesn't trigger the prompt.
 */
import { useEffect, useState } from "react";
import type * as React from "react";

import {
  defaultInteractableRegistry,
  promptForTarget,
  type Interactable,
  type Interactor,
  type InteractionPrompt,
} from "../input/interaction.js";

const PROMPT_KEY = "KeyE";

export interface InteractionPromptProps {
  /** The character's interactor (position + forward). */
  interactor: Interactor | null;
  /** The current interactable list (driven by entity_update). */
  interactables: readonly Interactable[];
  /**
   * Send an interact frame. For ship targets (action `'enter'`)
   * TASK-35 re-routes the press to `sendEnterShip()` instead of
   * the generic `sendInteract(targetId, action)` path, since
   * re-entry is its own server-side handler.
   */
  onInteract: (targetId: string, action: InteractionPrompt["action"]) => void;
  /**
   * TASK-35: optional re-entry dispatcher. When the resolved
   * action is `'enter'` (i.e. the target is the player's ship),
   * the prompt calls this instead of `onInteract`. Falls back to
   * `onInteract` when not supplied so existing TASK-33 callers
   * stay working.
   */
  onEnter?: () => void;
  /**
   * TASK-38: optional hold-E dispatcher for mining channels.
   * When the resolved action is `'mine'`, the prompt calls
   * `onMineStart(targetId)` on keydown and `onMineStop()` on
   * keyup — the same hold-E pattern the radial progress is
   * timed against. Falls back to `onInteract(targetId, 'mine')`
   * when not supplied.
   */
  onMineStart?: (targetId: string) => void;
  /** Companion stop hook for the hold-E mining flow. */
  onMineStop?: () => void;
  /** True while the WS is online. */
  enabled: boolean;
  /** Optional registry override (defaults to `defaultInteractableRegistry`). */
  registry?: typeof defaultInteractableRegistry;
}

/**
 * Bottom-centre prompt that disappears when no interactable is in
 * range or when the socket is offline.
 */
export function InteractionPrompt(props: InteractionPromptProps): React.JSX.Element | null {
  const {
    interactor,
    interactables,
    onInteract,
    onEnter,
    onMineStart,
    onMineStop,
    enabled,
    registry = defaultInteractableRegistry,
  } = props;
  const prompt = interactor === null ? null : promptForTarget(interactor, interactables, registry);
  const [pressed, setPressed] = useState(false);

  // Reset the "pressed" state whenever the prompt target switches
  // (or disappears) so a stuck affordance can't carry across.
  const targetKey = prompt ? `${prompt.targetId}:${prompt.action}` : "";
  useEffect(() => {
    setPressed(false);
  }, [targetKey]);

  useEffect(() => {
    if (prompt === null) return;
    if (!enabled) return;
    const isMining = prompt.action === "mine";
    const onKeyDown = (ev: KeyboardEvent): void => {
      // Ignore keystrokes that target text inputs so typing "e"
      // in the chat box doesn't trigger the prompt.
      const active = document.activeElement;
      const inTextField =
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        (active instanceof HTMLElement && active.isContentEditable);
      if (inTextField) return;
      if (ev.code !== PROMPT_KEY) return;
      if (ev.repeat) return;
      ev.preventDefault();
      if (pressed) return;
      setPressed(true);
      try {
        // TASK-38: hold-E mining — keydown starts the channel,
        // keyup stops it. The legacy tap dispatch fires once on
        // keydown so non-mining actions keep their existing
        // semantics.
        if (isMining && onMineStart) {
          onMineStart(prompt.targetId);
        } else if (prompt.action === "enter" && onEnter) {
          onEnter();
        } else {
          onInteract(prompt.targetId, prompt.action);
        }
      } catch {
        // Swallow — the `enabled` prop already gates on the socket
        // being open; a throw here means something exotic happened
        // (mid-frame disconnect). Reset so the player can retry.
        setPressed(false);
      }
    };
    const onKeyUp = (ev: KeyboardEvent): void => {
      if (ev.code !== PROMPT_KEY) return;
      if (!pressed) return;
      setPressed(false);
      if (isMining && onMineStop) {
        onMineStop();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [prompt, enabled, pressed, onInteract, onEnter, onMineStart, onMineStop]);

  if (prompt === null) return null;

  return (
    <div
      data-testid="drift-interact-prompt"
      data-target-id={prompt.targetId}
      data-action={prompt.action}
      style={{
        position: "absolute",
        left: "50%",
        // A bit higher than the existing exit-ship prompt so the
        // two never visually collide when both happen to be open
        // (e.g. the player is standing right next to their own
        // docked ship — in v1 the docked ship comes first via
        // ExitShipPrompt; this prompt takes the slot below it).
        bottom: 116,
        transform: "translateX(-50%)",
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 14px",
        background: "rgba(20, 24, 32, 0.85)",
        border: "1px solid rgba(230, 237, 243, 0.25)",
        borderRadius: 6,
        color: "#e6edf3",
        fontFamily: "system-ui, sans-serif",
        fontSize: 12,
        letterSpacing: "0.14em",
        textTransform: "uppercase",
        pointerEvents: "none",
      }}
    >
      <kbd
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          minWidth: 22,
          height: 22,
          padding: "0 6px",
          background: "rgba(230, 237, 243, 0.12)",
          border: "1px solid rgba(230, 237, 243, 0.35)",
          borderRadius: 3,
          fontFamily: "monospace",
          fontSize: 11,
          letterSpacing: 0,
        }}
      >
        E
      </kbd>
      <span data-testid="drift-interact-prompt-text">
        {pressed ? "Interacting…" : prompt.prompt}
      </span>
    </div>
  );
}
