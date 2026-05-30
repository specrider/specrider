/** True when the user has not asked the OS to reduce motion. Use as
 *  the gate for `behavior: "smooth"` scrolls — CSS transitions are
 *  already gated globally in styles.css. */
export function prefersReducedMotion(): boolean {
  if (
    typeof window === "undefined" ||
    typeof window.matchMedia !== "function"
  ) {
    return false;
  }
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Picks the right ScrollBehavior given the user's motion preference. */
export function scrollBehavior(): ScrollBehavior {
  return prefersReducedMotion() ? "auto" : "smooth";
}
