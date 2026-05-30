import { describe, expect, it } from "vitest";
import { hash32 } from "./hash";

describe("hash32 (FNV-1a 32-bit)", () => {
  it("returns the FNV-1a offset basis for an empty string", () => {
    // Standard FNV-1a 32-bit offset basis is 0x811c9dc5.
    expect(hash32("")).toBe("811c9dc5");
  });

  it("matches the canonical FNV-1a value for 'a'", () => {
    // Known vector: FNV-1a("a") = 0xe40c292c.
    expect(hash32("a")).toBe("e40c292c");
  });

  it("matches the canonical FNV-1a value for 'foobar'", () => {
    // Known vector: FNV-1a("foobar") = 0xbf9cf968.
    expect(hash32("foobar")).toBe("bf9cf968");
  });

  it("always returns an 8-char hex string padded with zeros", () => {
    for (const s of ["", "a", "foobar", "specrider"]) {
      expect(hash32(s)).toMatch(/^[0-9a-f]{8}$/);
    }
  });

  it("is deterministic", () => {
    expect(hash32("specrider")).toBe(hash32("specrider"));
  });
});
