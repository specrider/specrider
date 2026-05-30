export const DIFF_WIDE_LAYOUT_MIN_WIDTH = 900;

export function isWideDiffLayout(widthPx: number): boolean {
  return widthPx >= DIFF_WIDE_LAYOUT_MIN_WIDTH;
}
