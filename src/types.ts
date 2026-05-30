/** Group label for the Plans browser. The four well-known names get
 *  themed colors; any other directory name (e.g. `subprojects/auth/`)
 *  becomes its own bucket using the parent directory name. Files at
 *  the configured root with no parent directory go into "loose". */
export type Bucket = string;
export const KNOWN_BUCKETS = [
  "active",
  "upcoming",
  "backlog",
  "archive",
] as const;
export type PlanStatus = "in-progress" | "draft" | "shipped";

export interface LinkedRepoLink {
  repo: string;
  branch: string;
  base: string;
}

export interface FrontmatterIssue {
  field: string;
  message: string;
}

export interface Plan {
  id: string;
  title: string;
  path: string;
  bucket: Bucket;
  modifiedAt: string;
  modifiedRaw: number;
  lineCount: number;
  wordCount: number;
  readMinutes: number;
  /** Status from frontmatter only — null when not declared.
   *  Reader pill / "shipped" styling now key off bucket, not status. */
  status: PlanStatus | null;
  owner: string;
  contributors: string[];
  progress: { done: number; total: number };
  tags: string[];
  iterationCount: number;
  /** Branches whose commits should be folded into the diff explorer
   *  rail for this plan. From frontmatter `branches:`. Empty when
   *  unset. */
  gitBranches: string[];
  /** Explicit commit SHAs (short or full) to include alongside
   *  file-touching + branch commits. From frontmatter `commits:`.
   *  Empty when unset. */
  gitCommits: string[];
  /** Linked review targets from frontmatter `links:`. Unknown or
   *  malformed entries are omitted and reported in `frontmatterIssues`
   *  so the diff pane can degrade to the docs tab. */
  linkedRepoLinks: LinkedRepoLink[];
  frontmatterIssues: FrontmatterIssue[];
}

export interface OutlineTask {
  line: number;
  text: string;
  done: boolean;
  /** 0 for tasks directly under a heading, 1+ for tasks nested under
   *  another task. */
  depth: number;
}

export type OutlineListKind = "numbered" | "bulleted";

export interface OutlineListItem {
  line: number;
  text: string;
  kind: OutlineListKind;
  /** Literal source marker — e.g. "1.", "2.", "-", "*" — preserved so
   *  the renderer can keep the user's ordering and bullet glyph. */
  marker: string;
}

export interface OutlineNode {
  id: string;
  text: string;
  depth: 1 | 2 | 3;
  /** 1-based source line where the heading sits. */
  line: number;
  /** 1-based source line where this section ends (exclusive). End of
   *  document for the last section. */
  endLine: number;
  taskDone: number;
  taskTotal: number;
  /** Tasks appearing directly under this heading (not its sub-headings). */
  tasks: OutlineTask[];
  /** Non-task list items directly under this heading. */
  lists: OutlineListItem[];
  children: OutlineNode[];
}
