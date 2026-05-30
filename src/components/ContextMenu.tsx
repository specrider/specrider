import { useEffect, useMemo, useRef, useState } from "react";
import { useFocusTrap } from "../hooks/useFocusTrap";

export interface ContextMenuItem {
  label: string;
  onSelect?: () => void;
  /** Inline submenu opened on hover or via Right Arrow. */
  submenu?: ContextMenuItem[];
  /** Renders as a divider; `label` is ignored. */
  divider?: boolean;
  disabled?: boolean;
  /** Style as a destructive action (red text). */
  danger?: boolean;
}

interface Props {
  /** Viewport coordinates of the click that opened the menu. The menu
   *  positions itself there, clamped to the viewport. */
  anchor: { left: number; top: number };
  items: ContextMenuItem[];
  onClose: () => void;
  /** Trigger element to ignore in outside-click detection — without
   *  this, clicking a toggle button to dismiss the menu re-opens it
   *  on the trailing click handler. */
  triggerRef?: React.RefObject<HTMLElement | null>;
}

const MENU_WIDTH = 220;
const MENU_HEIGHT_GUESS = 280;

/** Keyboard-first context menu. Up/Down move, Enter/Space activate,
 *  Esc closes (sub first, then whole), Right opens submenu, Left
 *  closes submenu. Hover still works for mouse users. */
export function ContextMenu({ anchor, items, onClose, triggerRef }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  // useFocusTrap restores focus to the opener on unmount and prevents
  // Tab from leaving the menu. We disable autoFocus because we drive
  // initial focus ourselves through the roving cursor.
  useFocusTrap(ref, { autoFocus: false });

  const focusableTopIndices = useMemo(
    () => items.flatMap((it, i) => (!it.divider && !it.disabled ? [i] : [])),
    [items],
  );
  const [activeIdx, setActiveIdx] = useState<number>(
    () => focusableTopIndices[0] ?? -1,
  );
  const [openSubIdx, setOpenSubIdx] = useState<number | null>(null);
  const [activeSubIdx, setActiveSubIdx] = useState<number>(0);

  const topRefs = useRef<Array<HTMLDivElement | null>>([]);
  const subRefs = useRef<Array<HTMLDivElement | null>>([]);

  const focusableSubIndices = useMemo(() => {
    if (openSubIdx === null) return [];
    const sub = items[openSubIdx]?.submenu ?? [];
    return sub.flatMap((it, j) => (!it.divider && !it.disabled ? [j] : []));
  }, [items, openSubIdx]);

  // Drive focus from the cursor state. Top vs submenu wins by which
  // is "currently active".
  useEffect(() => {
    if (openSubIdx !== null) {
      subRefs.current[activeSubIdx]?.focus();
    } else if (activeIdx >= 0) {
      topRefs.current[activeIdx]?.focus();
    }
  }, [activeIdx, openSubIdx, activeSubIdx]);

  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (!ref.current) return;
      const target = e.target as Node;
      if (ref.current.contains(target)) return;
      if (triggerRef?.current?.contains(target)) return;
      onClose();
    };
    window.addEventListener("mousedown", onMouseDown);
    return () => window.removeEventListener("mousedown", onMouseDown);
  }, [onClose, triggerRef]);

  const moveTop = (delta: number) => {
    if (focusableTopIndices.length === 0) return;
    const cur = focusableTopIndices.indexOf(activeIdx);
    const next = cur + delta;
    const wrapped =
      next < 0
        ? focusableTopIndices[focusableTopIndices.length - 1]
        : next >= focusableTopIndices.length
          ? focusableTopIndices[0]
          : focusableTopIndices[next];
    setActiveIdx(wrapped);
    setOpenSubIdx(null);
  };

  const moveSub = (delta: number) => {
    if (focusableSubIndices.length === 0) return;
    const cur = focusableSubIndices.indexOf(activeSubIdx);
    const next = cur + delta;
    const wrapped =
      next < 0
        ? focusableSubIndices[focusableSubIndices.length - 1]
        : next >= focusableSubIndices.length
          ? focusableSubIndices[0]
          : focusableSubIndices[next];
    setActiveSubIdx(wrapped);
  };

  const openSub = (idx: number) => {
    const item = items[idx];
    if (!item || item.disabled || !item.submenu || item.submenu.length === 0)
      return;
    setOpenSubIdx(idx);
    const firstFocusable = item.submenu.findIndex(
      (s) => !s.divider && !s.disabled,
    );
    setActiveSubIdx(firstFocusable >= 0 ? firstFocusable : 0);
  };

  const activateTop = (idx: number) => {
    const item = items[idx];
    if (!item || item.disabled || item.divider) return;
    if (item.submenu && item.submenu.length > 0) {
      openSub(idx);
      return;
    }
    item.onSelect?.();
    onClose();
  };

  const activateSub = (j: number) => {
    if (openSubIdx === null) return;
    const sub = items[openSubIdx]?.submenu?.[j];
    if (!sub || sub.disabled || sub.divider) return;
    sub.onSelect?.();
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const inSub = openSubIdx !== null;
    switch (e.key) {
      case "Escape":
        e.preventDefault();
        if (inSub) setOpenSubIdx(null);
        else onClose();
        return;
      case "ArrowDown":
        e.preventDefault();
        if (inSub) moveSub(1);
        else moveTop(1);
        return;
      case "ArrowUp":
        e.preventDefault();
        if (inSub) moveSub(-1);
        else moveTop(-1);
        return;
      case "ArrowRight":
        if (!inSub) {
          const item = items[activeIdx];
          if (item?.submenu && item.submenu.length > 0) {
            e.preventDefault();
            openSub(activeIdx);
          }
        }
        return;
      case "ArrowLeft":
        if (inSub) {
          e.preventDefault();
          setOpenSubIdx(null);
        }
        return;
      case "Home":
        e.preventDefault();
        if (inSub) {
          if (focusableSubIndices.length > 0)
            setActiveSubIdx(focusableSubIndices[0]);
        } else if (focusableTopIndices.length > 0) {
          setActiveIdx(focusableTopIndices[0]);
          setOpenSubIdx(null);
        }
        return;
      case "End":
        e.preventDefault();
        if (inSub) {
          if (focusableSubIndices.length > 0)
            setActiveSubIdx(
              focusableSubIndices[focusableSubIndices.length - 1],
            );
        } else if (focusableTopIndices.length > 0) {
          setActiveIdx(focusableTopIndices[focusableTopIndices.length - 1]);
          setOpenSubIdx(null);
        }
        return;
      case "Enter":
      case " ":
        e.preventDefault();
        if (inSub) activateSub(activeSubIdx);
        else activateTop(activeIdx);
        return;
    }
  };

  const left = Math.max(
    8,
    Math.min(anchor.left, window.innerWidth - MENU_WIDTH - 8),
  );
  const top = Math.max(
    8,
    Math.min(anchor.top, window.innerHeight - MENU_HEIGHT_GUESS - 8),
  );

  return (
    <div
      className="context-menu"
      ref={ref}
      style={{ left, top }}
      role="menu"
      onKeyDown={onKeyDown}
    >
      {items.map((item, i) => {
        if (item.divider) {
          return (
            <hr
              className="context-menu-divider"
              key={`divider-${item.label || "top"}`}
            />
          );
        }
        const hasSubmenu = !!item.submenu && item.submenu.length > 0;
        const isActive = i === activeIdx && openSubIdx === null;
        const isOpenSub = openSubIdx === i;
        return (
          // biome-ignore lint/a11y/useKeyWithClickEvents: menu keyboard handling is centralized on the menu container.
          <div
            key={`item-${item.label}`}
            ref={(el) => {
              topRefs.current[i] = el;
            }}
            className={[
              "context-menu-item",
              item.disabled && "disabled",
              item.danger && "danger",
              hasSubmenu && "has-submenu",
              (isActive || isOpenSub) && "active",
            ]
              .filter(Boolean)
              .join(" ")}
            role="menuitem"
            tabIndex={i === activeIdx ? 0 : -1}
            aria-disabled={item.disabled || undefined}
            aria-haspopup={hasSubmenu || undefined}
            aria-expanded={hasSubmenu ? isOpenSub : undefined}
            onClick={() => {
              if (item.disabled) return;
              if (hasSubmenu) {
                if (isOpenSub) setOpenSubIdx(null);
                else openSub(i);
                return;
              }
              item.onSelect?.();
              onClose();
            }}
            onMouseEnter={() => {
              if (item.disabled) return;
              setActiveIdx(i);
              if (hasSubmenu) openSub(i);
              else setOpenSubIdx(null);
            }}
          >
            <span className="context-menu-label">{item.label}</span>
            {hasSubmenu && (
              <span className="context-menu-chevron" aria-hidden="true">
                ›
              </span>
            )}
            {hasSubmenu && isOpenSub && (
              <div className="context-menu-submenu" role="menu">
                {item.submenu?.map((sub, j) => {
                  if (sub.divider) {
                    return (
                      <hr
                        className="context-menu-divider"
                        key={`submenu-divider-${sub.label || item.label}`}
                      />
                    );
                  }
                  const isSubActive = j === activeSubIdx;
                  return (
                    // biome-ignore lint/a11y/useKeyWithClickEvents: menu keyboard handling is centralized on the menu container.
                    <div
                      key={`submenu-${item.label}-${sub.label}`}
                      ref={(el) => {
                        subRefs.current[j] = el;
                      }}
                      className={[
                        "context-menu-item",
                        sub.disabled && "disabled",
                        sub.danger && "danger",
                        isSubActive && "active",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      role="menuitem"
                      tabIndex={isSubActive ? 0 : -1}
                      aria-disabled={sub.disabled || undefined}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (sub.disabled) return;
                        sub.onSelect?.();
                        onClose();
                      }}
                      onMouseEnter={() => {
                        if (!sub.disabled) setActiveSubIdx(j);
                      }}
                    >
                      <span className="context-menu-label">{sub.label}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
