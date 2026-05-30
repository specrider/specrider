import { describe, expect, it } from "vitest";
import { formatHomePath } from "./pathDisplay";

describe("formatHomePath", () => {
  it("replaces an exact home path with tilde", () => {
    expect(formatHomePath("/Users/jake", "/Users/jake")).toBe("~");
  });

  it("replaces paths under home with a tilde prefix", () => {
    expect(formatHomePath("/Users/jake/Sites/specrider", "/Users/jake")).toBe(
      "~/Sites/specrider",
    );
  });

  it("handles a trailing separator in home", () => {
    expect(formatHomePath("/Users/jake/Sites", "/Users/jake/")).toBe("~/Sites");
  });

  it("leaves non-home paths unchanged", () => {
    expect(formatHomePath("/tmp/specrider", "/Users/jake")).toBe(
      "/tmp/specrider",
    );
  });
});
