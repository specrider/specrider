import { describe, expect, it } from "vitest";
import { isLinkedRepoTrustError } from "./linkedRepoTrust";

describe("isLinkedRepoTrustError", () => {
  it("matches missing and explicit linked repo trust failures", () => {
    expect(
      isLinkedRepoTrustError(
        "linked repo `code` has not been trusted for read access",
      ),
    ).toBe(true);
    expect(
      isLinkedRepoTrustError(
        "linked repo `code` is not trusted for terminal cwd",
      ),
    ).toBe(true);
  });

  it("ignores unrelated errors", () => {
    expect(isLinkedRepoTrustError("unknown linked repo handle `code`")).toBe(
      false,
    );
    expect(isLinkedRepoTrustError(null)).toBe(false);
  });
});
