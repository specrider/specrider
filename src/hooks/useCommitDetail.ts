// Fetches the diff body for the currently-selected row in the diff
// explorer's history rail. Routes through git_show_commit for real
// commits and git_status_unstaged for the synthetic Unstaged row.
//
// Refresh strategy:
//   - Selection changes → fetch fresh.
//   - For commits: cached on the Rust side by (repo_root, sha).
//     Effectively immutable, so we don't re-fetch on plan-changed.
//   - For Unstaged: re-fetch on every plan-changed (the working tree
//     just moved). Debounced to avoid thrashing on save bursts.

import { useCallback, useEffect, useRef, useState } from "react";
import type { CommitSelection } from "../components/CommitHistoryRail";
import {
  type CommitDetail,
  type CommitFileHeadersResponse,
  type FileChange,
  getCommitFile,
  getCommitFileHeaders,
  getUnstagedDetail,
  onPlanChanged,
  onWorkspaceTrustChanged,
} from "../tauri/api";

const REFRESH_DEBOUNCE_MS = 200;

export interface CommitDetailState {
  detail: CommitDetail | null;
  loading: boolean;
  error: string | null;
  loadFile: (file: FileChange) => void;
  refresh: () => void;
}

type CommitDetailData = Omit<CommitDetailState, "loadFile" | "refresh">;

export function useCommitDetail(
  selection: CommitSelection | null,
  repoHandle: string | null = null,
): CommitDetailState {
  const [state, setState] = useState<CommitDetailData>({
    detail: null,
    loading: false,
    error: null,
  });
  const timerRef = useRef<number | null>(null);
  const requestIdRef = useRef(0);
  const fileCacheRef = useRef<Map<string, FileChange>>(new Map());
  const inFlightRef = useRef<Set<string>>(new Set());
  const [refreshSeq, setRefreshSeq] = useState(0);

  const selectionKey =
    selection === null
      ? "none"
      : selection.kind === "unstaged"
        ? "unstaged"
        : `commit:${selection.sha}`;
  const commitSha = selection?.kind === "commit" ? selection.sha : null;
  const repoKey = repoHandle ?? "docs";

  const refresh = useCallback(() => {
    setRefreshSeq((seq) => seq + 1);
  }, []);

  const loadFile = useCallback(
    (file: FileChange) => {
      if (!commitSha || file.bodyLoaded !== false || file.binary) return;
      const cacheKey = lazyFileKey(selectionKey, file);
      const cached = fileCacheRef.current.get(cacheKey);
      if (cached) {
        setState((current) => replaceFile(current, commitSha, file, cached));
        return;
      }
      if (inFlightRef.current.has(cacheKey)) return;
      inFlightRef.current.add(cacheKey);

      void getCommitFile({
        sha: commitSha,
        path: file.path,
        oldPath: file.oldPath,
        repoHandle,
      })
        .then((loaded) => {
          const nextFile = { ...loaded, bodyLoaded: true };
          fileCacheRef.current.set(cacheKey, nextFile);
          setState((current) =>
            replaceFile(current, commitSha, file, nextFile),
          );
        })
        .catch((error) => {
          console.error(`Failed to load diff body for ${file.path}:`, error);
        })
        .finally(() => {
          inFlightRef.current.delete(cacheKey);
        });
    },
    [commitSha, selectionKey, repoHandle],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed deps avoid refetches from equivalent selection objects.
  useEffect(() => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    fileCacheRef.current = new Map();
    inFlightRef.current = new Set();
    if (!selection) {
      setState({ detail: null, loading: false, error: null });
      return;
    }

    const fetchDetail = async () => {
      setState((s) => ({ ...s, loading: true, error: null }));
      try {
        const detail =
          selection.kind === "unstaged"
            ? await getUnstagedDetail(repoHandle)
            : headersToCommitDetail(
                await getCommitFileHeaders(selection.sha, repoHandle),
              );
        if (requestIdRef.current !== requestId) return;
        setState({
          detail: markLoaded(detail),
          loading: false,
          error: null,
        });
      } catch (e) {
        if (requestIdRef.current !== requestId) return;
        setState({
          detail: null,
          loading: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    };

    void fetchDetail();

    // Only the unstaged view is volatile. Real commits don't change.
    let unlisten: (() => void) | null = null;
    let unlistenTrust: (() => void) | null = null;
    if (selection.kind === "unstaged") {
      const debouncedRefresh = () => {
        if (timerRef.current != null) window.clearTimeout(timerRef.current);
        timerRef.current = window.setTimeout(() => {
          timerRef.current = null;
          void fetchDetail();
        }, REFRESH_DEBOUNCE_MS);
      };
      void onPlanChanged(debouncedRefresh).then((un) => {
        if (requestIdRef.current !== requestId) {
          un();
        } else {
          unlisten = un;
        }
      });
    }
    void onWorkspaceTrustChanged(() => {
      void fetchDetail();
    }).then((un) => {
      if (requestIdRef.current !== requestId) {
        un();
      } else {
        unlistenTrust = un;
      }
    });

    return () => {
      requestIdRef.current += 1;
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
      timerRef.current = null;
      unlisten?.();
      unlistenTrust?.();
    };
  }, [selectionKey, repoKey, refreshSeq]);

  return { ...state, loadFile, refresh };
}

function headersToCommitDetail(
  response: CommitFileHeadersResponse,
): CommitDetail {
  return {
    sha: response.sha,
    shortSha: response.shortSha,
    authorName: response.authorName,
    authorEmail: response.authorEmail,
    timeSecs: response.timeSecs,
    subject: response.subject,
    body: response.body,
    files: response.files.map((file) => ({
      ...file,
      hunks: [],
      bodyLoaded: file.binary || file.additions + file.deletions === 0,
    })),
  };
}

function markLoaded(detail: CommitDetail): CommitDetail {
  if (detail.sha !== "unstaged") return detail;
  return {
    ...detail,
    files: detail.files.map((file) => ({ ...file, bodyLoaded: true })),
  };
}

function lazyFileKey(selectionKey: string, file: FileChange): string {
  return `${selectionKey}:${file.path}\0${file.oldPath ?? ""}`;
}

function replaceFile(
  current: CommitDetailData,
  sha: string,
  placeholder: FileChange,
  loaded: FileChange,
): CommitDetailData {
  if (!current.detail || current.detail.sha !== sha) return current;
  let changed = false;
  const files = current.detail.files.map((file) => {
    if (!sameFile(file, placeholder)) return file;
    changed = true;
    return loaded;
  });
  if (!changed) return current;
  return {
    ...current,
    detail: {
      ...current.detail,
      files,
    },
  };
}

function sameFile(left: FileChange, right: FileChange): boolean {
  if (left.path !== right.path) return false;
  const leftOld = left.oldPath ?? null;
  const rightOld = right.oldPath ?? null;
  return leftOld === rightOld || leftOld === null || rightOld === null;
}
