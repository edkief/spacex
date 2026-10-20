/**
 * MenuShell — TASK-53 ESC menu context + input gating.
 *
 * The shell owns a *stack* of transient surfaces (menu → ship →
 * settings). While the stack is non-empty:
 *
 *   - game input is suppressed (the capture-phase keydown handler
 *     swallows every key that is not handled by the panel),
 *   - `ESC` pops one level (panel → menu → closed),
 *   - focus is trapped inside the open surface and restored to the
 *     previously focused element when the stack empties.
 *
 * The world keeps simulating while the menu is open — this is a
 * multiplayer world, so the menu is a transient overlay, NOT a
 * pause. The server never learns that the menu is open.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type * as React from "react";

import {
  isMenuOpen,
  isPanelAllowedKey,
  popSurface,
  pushSurface,
  topSurface,
  type MenuSurface,
} from "./menuStack.js";

/** The value exposed to consumers of the shell. */
export interface MenuShellValue {
  /** The current surface stack (bottom → top). */
  readonly stack: readonly MenuSurface[];
  /** The surface on top of the stack (`null` when closed). */
  readonly top: MenuSurface | null;
  /** True while any surface is open. */
  readonly isOpen: boolean;
  /** Push a surface onto the stack. */
  open(surface: MenuSurface): void;
  /** Close every surface (back to the game). */
  close(): void;
  /** Pop one level — the ESC behaviour. */
  back(): void;
  /**
   * Register the DOM node of the currently open panel so the
   * input gate knows which keys the panel handles itself.
   */
  registerPanel(node: HTMLElement | null): void;
}

const MenuShellContext = createContext<MenuShellValue | null>(null);

/**
 * Read the menu shell, or `null` when the component is rendered
 * outside a provider. Used by surfaces that can run standalone (the
 * dock panel opened by a `ui_open` frame outside the shell).
 */
export function useOptionalMenuShell(): MenuShellValue | null {
  return useContext(MenuShellContext);
}

/**
 * Read the menu shell. Throws when used outside the provider so a
 * missing provider fails loudly instead of silently no-op'ing.
 */
export function useMenuShell(): MenuShellValue {
  const value = useContext(MenuShellContext);
  if (value === null) {
    throw new Error("useMenuShell must be used inside a <MenuShellProvider>");
  }
  return value;
}

/** Props for the provider. */
export interface MenuShellProviderProps {
  children: React.ReactNode;
  /**
   * Called when the shell closes the menu entirely (stack empty).
   * The host uses it to restore its own overlays (e.g. the star
   * chart) in a single place.
   */
  onClosed?: () => void;
}

/**
 * The provider. Mount it once, high in the tree (App.tsx), so the
 * whole HUD shares one stack.
 */
export function MenuShellProvider({
  children,
  onClosed,
}: MenuShellProviderProps): React.JSX.Element {
  const [stack, setStack] = useState<readonly MenuSurface[]>([]);
  const panelRef = useRef<HTMLElement | null>(null);
  // The element focused before the menu opened — restored when the
  // stack empties again.
  const restoreRef = useRef<HTMLElement | null>(null);

  const open = useCallback((surface: MenuSurface) => {
    setStack((prev) => {
      if (prev.length === 0) {
        restoreRef.current =
          document.activeElement instanceof HTMLElement ? document.activeElement : null;
      }
      return pushSurface(prev, surface);
    });
  }, []);

  const close = useCallback(() => {
    setStack((prev) => (prev.length === 0 ? prev : []));
  }, []);

  const back = useCallback(() => {
    setStack((prev) => popSurface(prev));
  }, []);

  const registerPanel = useCallback((node: HTMLElement | null) => {
    panelRef.current = node;
  }, []);

  // Restore focus + notify the host when the stack empties.
  const wasOpen = useRef(false);
  useEffect(() => {
    const open = isMenuOpen(stack);
    if (wasOpen.current && !open) {
      const restore = restoreRef.current;
      restoreRef.current = null;
      if (restore !== null && document.contains(restore)) {
        restore.focus();
      }
      onClosed?.();
    }
    wasOpen.current = open;
  }, [stack, onClosed]);

  // Input gating. The listener is registered in the *capture* phase
  // so it runs before the game's own window-level handlers; keys
  // that the open panel does not handle never reach them.
  useEffect(() => {
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === "Escape") {
        // ESC always belongs to the shell: it opens the menu when
        // nothing is open, otherwise it pops one level (panel →
        // menu → closed).
        ev.preventDefault();
        ev.stopPropagation();
        if (isMenuOpen(stack)) {
          back();
        } else {
          open("menu");
        }
        return;
      }
      if (!isMenuOpen(stack)) return;
      const target = ev.target;
      const panel = panelRef.current;
      const inPanel = panel !== null && target instanceof Node && panel.contains(target);
      // TASK-54: a surface may also declare itself with the
      // `data-menu-surface` attribute (the star chart does). Keys
      // the surface handles itself (Tab / Enter / arrows) must
      // reach it — otherwise the surface is mouse-only.
      const inSurface = target instanceof Element && target.closest("[data-menu-surface]") !== null;
      if ((inPanel || inSurface) && isPanelAllowedKey(ev.key)) {
        // The panel handles this key itself (Tab / Enter / arrows).
        return;
      }
      // Suppress the game input (movement, weapon select, chat
      // hotkeys …) while a surface is open.
      ev.preventDefault();
      ev.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [stack, open, back]);

  const value = useMemo<MenuShellValue>(
    () => ({
      stack,
      top: topSurface(stack),
      isOpen: isMenuOpen(stack),
      open,
      close,
      back,
      registerPanel,
    }),
    [stack, open, close, back, registerPanel],
  );

  return <MenuShellContext.Provider value={value}>{children}</MenuShellContext.Provider>;
}
