const MINUTE_SECS = 60;
const HOUR_SECS = 60 * MINUTE_SECS;
const DAY_SECS = 24 * HOUR_SECS;

export function formatRelativeTime(epochSecs: number): string {
  if (!epochSecs) return "";
  const ago = Math.max(0, Math.floor(Date.now() / 1000) - epochSecs);
  if (ago < MINUTE_SECS) return "just now";
  if (ago < HOUR_SECS) return `${Math.floor(ago / MINUTE_SECS)}m ago`;
  if (ago < DAY_SECS) return `${Math.floor(ago / HOUR_SECS)}h ago`;
  if (ago < DAY_SECS * 14) return `${Math.floor(ago / DAY_SECS)}d ago`;
  if (ago < DAY_SECS * 60) return `${Math.floor(ago / (DAY_SECS * 7))}w ago`;
  return new Date(epochSecs * 1000).toISOString().slice(0, 10);
}
