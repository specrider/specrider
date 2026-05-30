// Single shared git-status snapshot for the active window. The
// status-bar cluster, Pending Changes panel, branch picker, and
// conflict banner all read from this one source so we don't fan out
// duplicate `git_status` shellouts.
//
// Exposed via React context to keep Provider wiring out of every
// intermediate component. Consumers either read the snapshot
// (`useGitStatusContext()`) or trigger a refresh after a write
// (`useGitStatusContext().refresh()`).

import {
  createContext,
  type PropsWithChildren,
  type ReactNode,
  useContext,
} from "react";
import type { GitStatus } from "../tauri/api";
import { useGitStatus } from "./useGitStatus";

interface GitStatusContextValue {
  status: GitStatus | null;
  refresh: () => void;
}

const GitStatusContext = createContext<GitStatusContextValue | null>(null);

export function GitStatusProvider({
  intervalMs,
  children,
}: PropsWithChildren<{ intervalMs?: number }>): ReactNode {
  const value = useGitStatus(intervalMs);
  return (
    <GitStatusContext.Provider value={value}>
      {children}
    </GitStatusContext.Provider>
  );
}

export function useGitStatusContext(): GitStatusContextValue {
  const ctx = useContext(GitStatusContext);
  if (!ctx) {
    throw new Error(
      "useGitStatusContext must be used inside <GitStatusProvider>",
    );
  }
  return ctx;
}
