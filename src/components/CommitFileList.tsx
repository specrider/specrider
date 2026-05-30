// CommitFileList — file picker for the diff explorer's upper half.
//
// Flat list (no tree). Single-click selects a file; the parent then
// renders only that file's diff. Click the surrounding file-list
// surface to clear the selection and return to all files. Status badge
// / truncated path / +N/-N counts per row.

import { memo } from "react";
import type { FileChange } from "../tauri/api";

interface Props {
  files: FileChange[];
  /** Selected row. When set, the diff body is scoped to this file. */
  selectedPath: string | null;
  onSelect: (path: string) => void;
  onClearSelection: () => void;
  /** When non-null, render a checkbox before each row. Drives the
   *  unstaged-mode commit panel — checked rows are the ones that
   *  will be staged + committed. The header row gets a tri-state
   *  master checkbox. */
  selectedForCommit?: ReadonlySet<string> | null;
  onToggleCommit?: (path: string) => void;
  onToggleCommitAll?: () => void;
}

const STATUS_LABEL: Record<FileChange["status"], string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  copied: "C",
};

function shortenPath(path: string, maxSegments = 3): string {
  const segs = path.split("/").filter(Boolean);
  if (segs.length <= maxSegments) return path;
  return `.../${segs.slice(-maxSegments).join("/")}`;
}

export const CommitFileList = memo(function CommitFileList(props: Props) {
  const {
    files,
    selectedPath,
    onSelect,
    onClearSelection,
    selectedForCommit,
    onToggleCommit,
    onToggleCommitAll,
  } = props;

  if (files.length === 0) {
    return <div className="cfl-empty">No file changes in this selection.</div>;
  }

  const stagingMode = selectedForCommit != null && onToggleCommit != null;
  const allChecked =
    stagingMode &&
    files.length > 0 &&
    files.every((f) => selectedForCommit?.has(f.path));
  const someChecked =
    stagingMode && files.some((f) => selectedForCommit?.has(f.path));

  return (
    <ul className={`cfl-root ${stagingMode ? "staging" : ""}`}>
      {stagingMode && (
        <li className="cfl-staging-header">
          <input
            type="checkbox"
            aria-label="Toggle all"
            checked={!!allChecked}
            ref={(el) => {
              if (el) el.indeterminate = !allChecked && !!someChecked;
            }}
            onChange={() => onToggleCommitAll?.()}
            onClick={(e) => e.stopPropagation()}
          />
          <span className="cfl-staging-count">
            {Array.from(selectedForCommit ?? []).length} of {files.length}{" "}
            included
          </span>
        </li>
      )}
      {selectedPath && (
        <li className="cfl-filter-banner" role="status">
          Showing 1 file —{" "}
          <button
            type="button"
            className="cfl-filter-clear"
            onClick={(e) => {
              e.stopPropagation();
              onClearSelection();
            }}
          >
            clear
          </button>
        </li>
      )}
      {files.map((file) => (
        <CommitFileRow
          key={file.path + (file.oldPath ?? "")}
          file={file}
          isSelected={selectedPath === file.path}
          isChecked={!!selectedForCommit?.has(file.path)}
          stagingMode={stagingMode}
          onSelect={onSelect}
          onToggleCommit={onToggleCommit}
        />
      ))}
    </ul>
  );
});

interface CommitFileRowProps {
  file: FileChange;
  isSelected: boolean;
  isChecked: boolean;
  stagingMode: boolean;
  onSelect: (path: string) => void;
  onToggleCommit?: (path: string) => void;
}

const CommitFileRow = memo(function CommitFileRow({
  file,
  isSelected,
  isChecked,
  stagingMode,
  onSelect,
  onToggleCommit,
}: CommitFileRowProps) {
  const path = file.path;
  return (
    <li
      className={`cfl-row ${isSelected ? "selected" : ""}`}
      aria-current={isSelected || undefined}
      title={`${path}\n${file.additions} additions, ${file.deletions} deletions${
        file.oldPath && file.oldPath !== path
          ? `\nrenamed from ${file.oldPath}`
          : ""
      }`}
    >
      {stagingMode && (
        <input
          type="checkbox"
          className="cfl-check"
          aria-label={`Include ${path} in commit`}
          checked={isChecked}
          onChange={(e) => {
            e.stopPropagation();
            onToggleCommit?.(path);
          }}
          onClick={(e) => e.stopPropagation()}
        />
      )}
      <button
        type="button"
        className="cfl-row-button"
        onClick={(e) => {
          e.stopPropagation();
          onSelect(path);
        }}
      >
        <span className={`cfl-status status-${file.status}`}>
          {STATUS_LABEL[file.status]}
        </span>
        <span className="cfl-path">{shortenPath(path)}</span>
        <span className="cfl-counts">
          <span className="cfl-add">+{file.additions}</span>
          <span className="cfl-del">-{file.deletions}</span>
        </span>
      </button>
    </li>
  );
});
