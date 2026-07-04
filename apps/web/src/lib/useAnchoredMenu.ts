import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

export interface AnchoredMenu<T extends HTMLElement, M extends HTMLElement> {
  /** Attach to the trigger element the menu anchors to. */
  triggerRef: RefObject<T>;
  /** Attach to the portalled menu element. */
  menuRef: RefObject<M>;
  /** Fixed viewport coords for the menu; `null` until measured — render hidden until set. */
  coords: { top: number; left: number } | null;
}

/**
 * Position a portalled popover next to a trigger: opens upward when there's room
 * (flips down when cramped), right-aligns the menu to the trigger, then clamps
 * into the viewport. Closes on outside-click and re-places on scroll/resize while
 * open. `coords` is `null` until measured so the menu can render hidden to avoid a
 * flash at the wrong spot. Shared by the AI-assist and prompt-history controls.
 */
export function useAnchoredMenu<
  T extends HTMLElement = HTMLDivElement,
  M extends HTMLElement = HTMLDivElement,
>(open: boolean, onClose: () => void): AnchoredMenu<T, M> {
  const triggerRef = useRef<T>(null);
  const menuRef = useRef<M>(null);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
  // Keep the latest onClose without re-subscribing the listeners every render.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const place = useCallback(() => {
    const trigger = triggerRef.current;
    const menu = menuRef.current;
    if (!trigger || !menu) return;
    const t = trigger.getBoundingClientRect();
    const m = menu.getBoundingClientRect();
    const gap = 6;
    const margin = 8;

    // Prefer opening upward (over the field); flip down when cramped above.
    const fitsAbove = t.top >= m.height + gap + margin;
    const top = fitsAbove ? t.top - gap - m.height : t.bottom + gap;

    // Align the menu's right edge to the trigger, then clamp into the viewport.
    const left = Math.min(
      Math.max(margin, t.right - m.width),
      window.innerWidth - margin - m.width,
    );

    setCoords({
      top: Math.min(Math.max(margin, top), window.innerHeight - margin - m.height),
      left,
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      setCoords(null);
      return;
    }
    place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      onCloseRef.current();
    };
    const reposition = () => place();
    window.addEventListener("mousedown", onDown);
    // Keep the menu anchored as the page scrolls or the window resizes.
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
  }, [open, place]);

  return { triggerRef, menuRef, coords };
}
