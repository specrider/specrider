import { describe, expect, it } from "vitest";
import {
  focusTerminalCwdPane,
  initialTerminalCwdFollowState,
  requestTerminalCwd,
  shouldRequestCwdForDiffTargetChange,
  terminalCwdRepoHandle,
} from "./terminalCwdFollow";

describe("terminal cwd follow state", () => {
  it("requests cwd only when the focused review pane changes", () => {
    const initial = initialTerminalCwdFollowState();

    const repeatedReader = focusTerminalCwdPane(initial, "reader");
    expect(repeatedReader).toBe(initial);

    const diff = focusTerminalCwdPane(initial, "diff");
    expect(diff.followPane).toBe("diff");
    expect(diff.requestSeq).toBe(1);

    const repeatedDiff = focusTerminalCwdPane(diff, "diff");
    expect(repeatedDiff).toBe(diff);
  });

  it("keeps manual terminal cd sticky until focus returns to a review pane", () => {
    const diff = focusTerminalCwdPane(initialTerminalCwdFollowState(), "diff");
    const terminal = focusTerminalCwdPane(diff, "terminal");

    expect(terminal.followPane).toBe("diff");
    expect(terminal.requestSeq).toBe(diff.requestSeq);

    const reader = focusTerminalCwdPane(terminal, "reader");
    expect(reader.followPane).toBe("reader");
    expect(reader.requestSeq).toBe(diff.requestSeq + 1);
  });

  it("requests cwd for active diff target changes only while diff is focused", () => {
    const reader = initialTerminalCwdFollowState();
    expect(shouldRequestCwdForDiffTargetChange(reader)).toBe(false);

    const diff = focusTerminalCwdPane(reader, "diff");
    expect(shouldRequestCwdForDiffTargetChange(diff)).toBe(true);

    const refreshed = requestTerminalCwd(diff);
    expect(refreshed.requestSeq).toBe(diff.requestSeq + 1);
  });

  it("maps reader to docs cwd and diff to the active linked repo handle", () => {
    const reader = initialTerminalCwdFollowState();
    expect(terminalCwdRepoHandle(reader, "code")).toBe(null);

    const diff = focusTerminalCwdPane(reader, "diff");
    expect(terminalCwdRepoHandle(diff, "code")).toBe("code");
    expect(terminalCwdRepoHandle(diff, null)).toBe(null);
  });
});
