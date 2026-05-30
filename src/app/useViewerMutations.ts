import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { useCallback, useEffect, useRef } from "react";
import type { MarkdownEditorHandle } from "../components/MarkdownEditor";
import type { ReaderMode } from "../components/Reader";
import {
  insertTaskAfter as insertTaskAfterOp,
  moveTaskBlock as moveTaskBlockOp,
  removeTaskBlock as removeTaskBlockOp,
} from "../markdown/taskOps";

interface UseViewerMutationsArgs {
  editorRef: MutableRefObject<MarkdownEditorHandle | null>;
  mode: ReaderMode;
  rawMd: string;
  rawMdOwnerRef: MutableRefObject<string>;
  setMode: Dispatch<SetStateAction<ReaderMode>>;
  setParseSource: Dispatch<SetStateAction<string>>;
  setRawMd: Dispatch<SetStateAction<string>>;
}

type ViewerEntry = { before: string; after: string };

export function useViewerMutations({
  editorRef,
  mode,
  rawMd,
  rawMdOwnerRef,
  setMode,
  setParseSource,
  setRawMd,
}: UseViewerMutationsArgs) {
  const rawMdRef = useRef("");
  const viewerUndoRef = useRef<{
    path: string;
    entries: ViewerEntry[];
  }>({ path: "", entries: [] });
  const viewerRedoRef = useRef<{
    path: string;
    entries: ViewerEntry[];
  }>({ path: "", entries: [] });

  useEffect(() => {
    rawMdRef.current = rawMd;
  }, [rawMd]);

  const pushViewerUndo = useCallback(
    (before: string, after: string) => {
      const owner = rawMdOwnerRef.current || "";
      if (viewerUndoRef.current.path !== owner) {
        viewerUndoRef.current = { path: owner, entries: [] };
      }
      viewerUndoRef.current.entries.push({ before, after });
      if (viewerUndoRef.current.entries.length > 200) {
        viewerUndoRef.current.entries.shift();
      }
      viewerRedoRef.current = { path: owner, entries: [] };
    },
    [rawMdOwnerRef],
  );

  const applyViewerMutation = useCallback(
    (next: string) => {
      rawMdRef.current = next;
      setRawMd(next);
      setParseSource(next);
    },
    [setParseSource, setRawMd],
  );

  const toggleTask = useCallback(
    (line: number, checked: boolean) => {
      const prev = rawMdRef.current;
      const lines = prev.split("\n");
      const idx = line - 1;
      if (idx < 0 || idx >= lines.length) return;
      const updated = lines[idx].replace(
        /([-*+])(\s+)\[[ xX]\]/,
        checked ? "$1$2[x]" : "$1$2[ ]",
      );
      if (updated === lines[idx]) return;
      lines[idx] = updated;
      const next = lines.join("\n");
      pushViewerUndo(prev, next);
      applyViewerMutation(next);
    },
    [applyViewerMutation, pushViewerUndo],
  );

  const insertTaskAfter = useCallback(
    (startLine: number, endLine: number) => {
      const prev = rawMdRef.current;
      const result = insertTaskAfterOp(prev, startLine, endLine);
      if (!result) return;
      const { next, newTaskLine } = result;
      pushViewerUndo(prev, next);
      applyViewerMutation(next);
      if (mode === "read") setMode("split");
      requestAnimationFrame(() => {
        editorRef.current?.scrollToLine(newTaskLine, {
          placeCursor: "afterTaskMarker",
        });
        editorRef.current?.focus();
      });
    },
    [applyViewerMutation, editorRef, mode, pushViewerUndo, setMode],
  );

  const removeTaskBlock = useCallback(
    (startLine: number, endLine: number) => {
      const prev = rawMdRef.current;
      const next = removeTaskBlockOp(prev, startLine, endLine);
      if (next === prev) return;
      pushViewerUndo(prev, next);
      applyViewerMutation(next);
    },
    [applyViewerMutation, pushViewerUndo],
  );

  const moveTaskBlock = useCallback(
    (
      fromStart: number,
      fromEnd: number,
      anchorLine: number,
      position: "before" | "after",
      newIndent: number,
    ) => {
      const prev = rawMdRef.current;
      const next = moveTaskBlockOp(
        prev,
        fromStart,
        fromEnd,
        anchorLine,
        position,
        newIndent,
      );
      if (next === prev) return;
      pushViewerUndo(prev, next);
      applyViewerMutation(next);
    },
    [applyViewerMutation, pushViewerUndo],
  );

  const viewerUndo = useCallback(() => {
    const owner = rawMdOwnerRef.current || "";
    const stack = viewerUndoRef.current;
    if (stack.path !== owner) {
      viewerUndoRef.current = { path: owner, entries: [] };
      viewerRedoRef.current = { path: owner, entries: [] };
      return;
    }
    const entry = stack.entries.pop();
    if (!entry) return;
    if (entry.after !== rawMdRef.current) {
      stack.entries = [];
      viewerRedoRef.current = { path: owner, entries: [] };
      return;
    }
    viewerRedoRef.current.path = owner;
    viewerRedoRef.current.entries.push(entry);
    applyViewerMutation(entry.before);
  }, [applyViewerMutation, rawMdOwnerRef]);

  const viewerRedo = useCallback(() => {
    const owner = rawMdOwnerRef.current || "";
    const stack = viewerRedoRef.current;
    if (stack.path !== owner) {
      viewerRedoRef.current = { path: owner, entries: [] };
      return;
    }
    const entry = stack.entries.pop();
    if (!entry) return;
    if (entry.before !== rawMdRef.current) {
      stack.entries = [];
      return;
    }
    viewerUndoRef.current.path = owner;
    viewerUndoRef.current.entries.push(entry);
    applyViewerMutation(entry.after);
  }, [applyViewerMutation, rawMdOwnerRef]);

  return {
    insertTaskAfter,
    moveTaskBlock,
    removeTaskBlock,
    toggleTask,
    viewerRedo,
    viewerUndo,
  };
}
