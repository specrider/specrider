import { memo, type ReactElement } from "react";
import type { CommitDerived } from "../hooks/useCommitGraph";
import { type LaneAssignment, laneColor } from "../lib/commitGraphLanes";
import type { GraphCommit, PlanRelevance, RefEntry } from "../tauri/api";
import type { CommitSelection } from "./CommitHistoryRail";

const LANE_CELL_PX = 14;
const LANE_ROW_PX = 24;
const DOT_RADIUS = 3.5;

interface LaneGlyphsProps {
  row: LaneAssignment;
  laneCount: number;
}

const LaneGlyphs = memo(function LaneGlyphs(props: LaneGlyphsProps) {
  const { row, laneCount } = props;
  const width = laneCount * LANE_CELL_PX;
  const height = LANE_ROW_PX;
  const midY = height / 2;
  const laneX = (i: number) => i * LANE_CELL_PX + LANE_CELL_PX / 2;
  const dotX = laneX(row.laneIndex);

  const segments: ReactElement[] = [];

  for (let i = 0; i < row.priorLanes.length; i++) {
    if (row.priorLanes[i] === null) continue;
    const x = laneX(i);
    const color = laneColor(i);
    if (i === row.laneIndex) {
      segments.push(
        <line
          key={`pt-${i}`}
          x1={x}
          y1={0}
          x2={x}
          y2={midY}
          stroke={color}
          strokeWidth={1.5}
        />,
      );
    } else if (i < row.nextLanes.length && row.nextLanes[i] !== null) {
      segments.push(
        <line
          key={`pt-${i}`}
          x1={x}
          y1={0}
          x2={x}
          y2={height}
          stroke={color}
          strokeWidth={1.5}
        />,
      );
    } else {
      segments.push(
        <line
          key={`pt-${i}`}
          x1={x}
          y1={0}
          x2={dotX}
          y2={midY}
          stroke={color}
          strokeWidth={1.5}
        />,
      );
    }
  }

  for (let i = 0; i < row.nextLanes.length; i++) {
    if (row.nextLanes[i] === null) continue;
    const x = laneX(i);
    const color = laneColor(i);
    const wasActiveAbove =
      i < row.priorLanes.length && row.priorLanes[i] !== null;
    if (i === row.laneIndex) {
      segments.push(
        <line
          key={`pb-${i}`}
          x1={x}
          y1={midY}
          x2={x}
          y2={height}
          stroke={color}
          strokeWidth={1.5}
        />,
      );
    } else if (!wasActiveAbove) {
      segments.push(
        <line
          key={`pb-${i}`}
          x1={dotX}
          y1={midY}
          x2={x}
          y2={height}
          stroke={color}
          strokeWidth={1.5}
        />,
      );
    }
  }

  const dotColor = laneColor(row.laneIndex);
  segments.push(
    <circle
      key="dot"
      cx={dotX}
      cy={midY}
      r={row.isMerge ? DOT_RADIUS + 1 : DOT_RADIUS}
      fill={dotColor}
      stroke={row.isMerge ? "var(--paper-2)" : "none"}
      strokeWidth={row.isMerge ? 1.5 : 0}
    />,
  );

  return (
    <svg
      className="ch-lanes"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
    >
      {segments}
    </svg>
  );
});

function refLabelClass(r: RefEntry, hasRelevance: boolean): string {
  if (r.isHead) return "ch-ref ch-ref-head";
  if (r.isDefaultBranch) return "ch-ref ch-ref-default";
  if (r.kind === "tag") return "ch-ref ch-ref-tag";
  if (r.kind === "remote") return "ch-ref ch-ref-remote";
  return hasRelevance ? "ch-ref ch-ref-tracked" : "ch-ref";
}

export interface CommitRowProps {
  commit: GraphCommit;
  row: LaneAssignment;
  refs: readonly RefEntry[];
  relevance: PlanRelevance | null;
  derived: CommitDerived;
  isSelected: boolean;
  isUnpushed: boolean;
  onSelect: (sel: CommitSelection) => void;
  showLanes: boolean;
  laneCount: number;
  ariaPosInSet: number;
  ariaSetSize: number;
  /** Roving tabindex — set to 0 for the cursor row; -1 otherwise. */
  tabIndex: 0 | -1;
  onFocus?: () => void;
}

function CommitRowInner(props: CommitRowProps) {
  const {
    commit,
    row,
    refs,
    relevance,
    derived,
    isSelected,
    isUnpushed,
    onSelect,
    showLanes,
    laneCount,
    ariaPosInSet,
    ariaSetSize,
    tabIndex,
    onFocus,
  } = props;
  const relevanceClass = relevance
    ? `ch-rel ch-rel-${relevance.source}`
    : "ch-rel-none";

  return (
    <button
      type="button"
      data-sha={commit.sha}
      tabIndex={tabIndex}
      onFocus={onFocus}
      className={`ch-row ch-row-graph ${relevanceClass} ${
        isSelected ? "selected" : ""
      } ${showLanes ? "" : "no-lanes"} ${isUnpushed ? "unpushed" : ""}`}
      onClick={() => onSelect({ kind: "commit", sha: commit.sha })}
      aria-current={isSelected || undefined}
      aria-label={`${ariaPosInSet} of ${ariaSetSize}: ${commit.subject}`}
      title={`${commit.subject}\n\n${commit.authorName} <${commit.authorEmail}>\n${commit.shortSha}${
        isUnpushed ? "\n\n↑ Not yet pushed to upstream" : ""
      }`}
    >
      {showLanes && <LaneGlyphs row={row} laneCount={laneCount} />}
      <span className="ch-refs">
        {refs.map((r) => (
          <span
            key={`${r.kind}:${r.name}`}
            className={refLabelClass(r, !!relevance)}
            title={`${r.isHead ? "HEAD · " : ""}${r.kind} · ${r.name}`}
          >
            {relevance?.source === "branch" && relevance.branch === r.name && (
              <span className="ch-ref-pin" aria-hidden="true">
                •
              </span>
            )}
            {r.name}
          </span>
        ))}
        {relevance?.source === "explicit" && (
          <span
            className="ch-ref ch-ref-pinned"
            title="Pinned via plan frontmatter"
          >
            📌
          </span>
        )}
      </span>
      <span className="ch-subject">{commit.subject}</span>
      <span className="ch-meta">
        {isUnpushed && (
          <span className="ch-unpushed-chip" title="Not yet pushed to upstream">
            ↑
          </span>
        )}
        <span className="ch-author">{derived.initials}</span>
        <span className="ch-time">{derived.rel}</span>
        <span className="ch-sha">{commit.shortSha}</span>
      </span>
    </button>
  );
}

export const CommitRow = memo(
  CommitRowInner,
  (a, b) =>
    a.commit === b.commit &&
    a.row === b.row &&
    a.refs === b.refs &&
    a.relevance === b.relevance &&
    a.derived === b.derived &&
    a.isSelected === b.isSelected &&
    a.isUnpushed === b.isUnpushed &&
    a.onSelect === b.onSelect &&
    a.showLanes === b.showLanes &&
    a.laneCount === b.laneCount &&
    a.ariaPosInSet === b.ariaPosInSet &&
    a.ariaSetSize === b.ariaSetSize &&
    a.tabIndex === b.tabIndex &&
    a.onFocus === b.onFocus,
);
