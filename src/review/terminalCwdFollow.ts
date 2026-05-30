export type ReviewPaneFocus = "reader" | "diff";
export type AppPaneFocus = ReviewPaneFocus | "terminal";

export interface TerminalCwdFollowState {
  focusedPane: AppPaneFocus;
  followPane: ReviewPaneFocus;
  requestSeq: number;
}

export function initialTerminalCwdFollowState(): TerminalCwdFollowState {
  return {
    focusedPane: "reader",
    followPane: "reader",
    requestSeq: 0,
  };
}

export function focusTerminalCwdPane(
  state: TerminalCwdFollowState,
  pane: AppPaneFocus,
): TerminalCwdFollowState {
  if (state.focusedPane === pane) return state;
  if (pane === "terminal") {
    return { ...state, focusedPane: pane };
  }
  return {
    focusedPane: pane,
    followPane: pane,
    requestSeq: state.requestSeq + 1,
  };
}

export function requestTerminalCwd(
  state: TerminalCwdFollowState,
): TerminalCwdFollowState {
  return { ...state, requestSeq: state.requestSeq + 1 };
}

export function shouldRequestCwdForDiffTargetChange(
  state: TerminalCwdFollowState,
): boolean {
  return state.focusedPane === "diff";
}

export function terminalCwdRepoHandle(
  state: TerminalCwdFollowState,
  activeDiffRepoHandle: string | null,
): string | null {
  return state.followPane === "diff" ? activeDiffRepoHandle : null;
}
