import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatRelativeTime } from "./time";

describe("formatRelativeTime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns an empty string for a missing epoch", () => {
    expect(formatRelativeTime(0)).toBe("");
  });

  it("formats seconds as just now", () => {
    expect(formatRelativeTime(Date.parse("2026-05-15T11:59:31Z") / 1000)).toBe(
      "just now",
    );
  });

  it("formats minutes, hours, days, and weeks", () => {
    expect(formatRelativeTime(Date.parse("2026-05-15T11:55:00Z") / 1000)).toBe(
      "5m ago",
    );
    expect(formatRelativeTime(Date.parse("2026-05-15T09:00:00Z") / 1000)).toBe(
      "3h ago",
    );
    expect(formatRelativeTime(Date.parse("2026-05-12T12:00:00Z") / 1000)).toBe(
      "3d ago",
    );
    expect(formatRelativeTime(Date.parse("2026-04-24T12:00:00Z") / 1000)).toBe(
      "3w ago",
    );
  });

  it("falls back to an ISO date for older timestamps", () => {
    expect(formatRelativeTime(Date.parse("2026-02-14T12:00:00Z") / 1000)).toBe(
      "2026-02-14",
    );
  });
});
