import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

export interface PlanFileMeta {
  /** Forward-slash relative path from the configured plans root. */
  path: string;
  modifiedSecs: number;
  size: number;
  lineCount: number;
  wordCount: number;
  taskDone: number;
  taskTotal: number;
  /** Parsed YAML frontmatter, or `null` if absent / malformed. */
  frontmatter: Record<string, unknown> | null;
  /** First `# ` heading in the body, trimmed. `null` if the doc has none. */
  h1: string | null;
}

export interface PlanChangeEvent {
  path: string;
  kind: "created" | "modified" | "removed";
}

export async function getPlansRoot(): Promise<string | null> {
  return await invoke<string | null>("get_plans_root");
}

export async function setPlansRoot(path: string): Promise<void> {
  await invoke("set_plans_root", { path });
}

export async function setWindowTitle(title: string): Promise<void> {
  await invoke("set_window_title", { title });
}

/** Opens a native folder picker; sets the plans root to whatever the user chooses.
 *  Returns the chosen path, or `null` if the dialog was cancelled. */
export async function pickPlansRoot(): Promise<string | null> {
  const picked = await openDialog({ directory: true, multiple: false });
  if (typeof picked !== "string") return null;
  await setPlansRoot(picked);
  return picked;
}

/** Opens a native file picker filtered to Markdown; sets the plans
 *  root to the chosen file's parent directory and seeds the filename
 *  as the auto-selected plan. Returns the picked absolute path, or
 *  `null` if the dialog was cancelled. */
export async function pickSingleMarkdownFile(): Promise<string | null> {
  const picked = await openDialog({
    multiple: false,
    filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
  });
  if (typeof picked !== "string") return null;
  await invoke("open_single_file", { path: picked });
  return picked;
}

export interface RecentProject {
  /** Absolute filesystem path. */
  path: string;
  /** Project name — wrapper segments like `docs`/`plans` skipped. */
  name: string;
  /** Tilde-collapsed path for display. */
  displayPath: string;
}

/** Most recently opened plans roots, filtered to ones that still exist. */
export async function listRecentProjects(): Promise<RecentProject[]> {
  return await invoke<RecentProject[]>("list_recent_projects");
}

/** Opens a native save dialog and writes `contents` to the chosen
 *  path. Returns the path written to, or `null` if the user
 *  cancelled. The dialog runs *inside Rust* so the destination path
 *  never round-trips through JS — the picker and the write are a
 *  single, atomic step from the frontend's perspective. */
export async function exportToFile(args: {
  defaultPath: string;
  filters: { name: string; extensions: string[] }[];
  contents: string;
}): Promise<string | null> {
  return await invoke<string | null>("export_with_dialog", {
    args: {
      defaultName: args.defaultPath,
      filters: args.filters,
      contents: args.contents,
    },
  });
}

/** Fast listing for startup and file-change refreshes. Expensive
 *  analysis fields are zero/null until `analyzePlans()` hydrates them. */
export async function listPlans(): Promise<PlanFileMeta[]> {
  return await invoke<PlanFileMeta[]>("list_plans");
}

/** Returns the same shape as `listPlans`, with frontmatter / title /
 *  word-count / task-count fields populated. Intended for background
 *  hydration after the fast listing has painted. */
export async function analyzePlans(): Promise<PlanFileMeta[]> {
  return await invoke<PlanFileMeta[]>("analyze_plans");
}

export async function readPlan(relPath: string): Promise<string> {
  return await invoke<string>("read_plan", { relPath });
}

export async function writePlan(
  relPath: string,
  contents: string,
): Promise<void> {
  await invoke("write_plan", { relPath, contents });
}

/** Move a plan to a new relative path inside the plans root.
 *  Atomic rename; both source and destination are tombstoned in the
 *  watcher so the resulting Remove + Create pair doesn't echo back. */
export async function movePlan(fromRel: string, toRel: string): Promise<void> {
  await invoke("move_plan", { fromRel, toRel });
}

/** Rename a plan in place, preserving its parent directory. The
 *  `newBasename` is taken as a filename — `.md` is appended when
 *  absent. Returns the new relative path. */
export async function renamePlan(
  rel: string,
  newBasename: string,
): Promise<string> {
  return await invoke<string>("rename_plan", { rel, newBasename });
}

/** Move a plan to the OS trash (recoverable from Finder / Recycle
 *  Bin). Errors if the file isn't tracked. */
export async function deletePlan(rel: string): Promise<void> {
  await invoke("delete_plan", { rel });
}

/** Duplicate a plan, returning the new relative path. The copy is
 *  named `<stem>-copy.md`, then `<stem>-copy-2.md`, etc. as needed. */
export async function duplicatePlan(rel: string): Promise<string> {
  return await invoke<string>("duplicate_plan", { rel });
}

/** Create a new plan. Auto-appends `.md` if missing. Default seed is
 *  an H1 derived from the basename. Returns the relative path. */
export async function createPlan(
  rel: string,
  initial?: string,
): Promise<string> {
  return await invoke<string>("create_plan", { rel, initial });
}

/** Reveal the plan in the OS file manager (Finder / Explorer / file
 *  manager). Highlights the file when the platform supports it. */
export async function revealPlan(rel: string): Promise<void> {
  await invoke("reveal_plan", { rel });
}

/** Create a new (empty) folder under the plans root. Errors if the
 *  folder already exists. */
export async function createFolder(rel: string): Promise<void> {
  await invoke("create_folder", { rel });
}

/** Move a folder to a new relative path. Refuses to move a folder
 *  under itself. */
export async function moveFolder(
  fromRel: string,
  toRel: string,
): Promise<void> {
  await invoke("move_folder", { fromRel, toRel });
}

/** Rename a folder in place; preserves its parent. Returns the new
 *  relative path. */
export async function renameFolder(
  rel: string,
  newBasename: string,
): Promise<string> {
  return await invoke<string>("rename_folder", { rel, newBasename });
}

/** Move a folder to the OS trash. Refuses non-empty folders unless
 *  `force` is true. */
export async function deleteFolder(
  rel: string,
  force?: boolean,
): Promise<void> {
  await invoke("delete_folder", { rel, force });
}

/** Spawn a new window pointed at the *current* window's plansRoot
 *  with the specified plan pre-selected. Distinct from File → New
 *  Window (which loads the configured default folder). */
export async function openPlanInNewWindow(planRel: string): Promise<void> {
  await invoke("open_plan_in_new_window", { planRel });
}

export interface InitialState {
  plansRoot: string | null;
  /** One-shot plan to seed `activeId` before list_plans resolves.
   *  Cleared after this call returns — refreshes won't re-jump. */
  activePlan: string | null;
}

/** Read the per-window initial state on first paint. Used by windows
 *  spawned via `open_plan_in_new_window` to land on a specific plan
 *  instead of the default newest-mtime selection. */
export async function getInitialState(): Promise<InitialState> {
  return await invoke<InitialState>("get_initial_state");
}

/** A single hunk pulled from `git diff --unified=0 HEAD -- <path>`. */
export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Raw deleted text (one line per `\n`). */
  before: string;
  /** Raw added text (one line per `\n`). */
  after: string;
}

export interface ChangeSet {
  /** Working-tree line numbers (1-based) that are net additions. */
  added: number[];
  /** Working-tree line numbers (1-based) that have both deletions and additions. */
  modified: number[];
  /** Working-tree line numbers after which a deleted block sits — the
   *  marker is rendered between this line and the next. */
  deletedAfter: number[];
  hunks: Hunk[];
}

export interface ChangedPlan {
  /** Forward-slash relative path from the configured plans root. */
  rel: string;
  addedCount: number;
  modifiedCount: number;
  removedCount: number;
}

/** Fetches the working-tree-vs-HEAD diff for a single plan. Empty when
 *  the file is untracked, the directory isn't a git repo, or git isn't
 *  available — all "no diff" scenarios degrade to an empty ChangeSet. */
export async function diffPlan(planRel: string): Promise<ChangeSet> {
  return await invoke<ChangeSet>("diff_plan", { planRel });
}

/** Single batched call: returns one entry per modified plan in the
 *  active plans root (relative paths). */
export async function listChangedPlans(): Promise<ChangedPlan[]> {
  return await invoke<ChangedPlan[]>("list_changed_plans");
}

export interface BlameLine {
  /** 1-based working-tree line number. */
  line: number;
  /** 8-char short SHA. Empty when `uncommitted`. */
  sha: string;
  author: string;
  /** Unix seconds. */
  authorTime: number;
  /** Commit subject (first line of the message). */
  summary: string;
  uncommitted: boolean;
}

export interface BlameCommit {
  sha: string;
  subject: string;
  author: string;
  authorTime: number;
}

export interface BlameSet {
  lines: BlameLine[];
  /** Short SHA → commit summary. Sourced from the porcelain blame
   *  output; the per-commit body and file list come from
   *  `commitMeta(sha)` on demand. */
  commits: Record<string, BlameCommit>;
}

export interface CommitMeta {
  sha: string;
  subject: string;
  body: string;
  author: string;
  authorTime: number;
  files: string[];
  /** Permalink to the commit on github when origin is a github remote. */
  githubUrl: string | null;
}

/** Per-line blame for the active plan. Returns an empty BlameSet when
 *  the file isn't in a git repo, hasn't been committed, or git isn't
 *  available — same graceful no-op posture as `diffPlan`. */
export async function blamePlan(planRel: string): Promise<BlameSet> {
  return await invoke<BlameSet>("blame_plan", { planRel });
}

/** Full commit metadata for the popover. App-wide cached by SHA on the
 *  Rust side (commits are immutable). */
export async function commitMeta(sha: string): Promise<CommitMeta> {
  return await invoke<CommitMeta>("commit_meta", { sha });
}

/** Branch info for the active window's plansRoot. `null` when the
 *  directory isn't inside a Git work tree (or no plansRoot is
 *  configured). */
export interface BranchInfo {
  name: string;
  detached: boolean;
  shortSha: string | null;
}

export async function getGitBranch(): Promise<BranchInfo | null> {
  return await invoke<BranchInfo | null>("git_branch");
}

// ─── Full git status ────────────────────────────────────────────────────

export type ChangeKind =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "untracked"
  | "conflicted"
  | "other";

export interface ChangedFile {
  /** Repo-relative forward-slash path. */
  path: string;
  /** Plans-root-relative path when the file lives under plansRoot,
   *  else null. UI uses this to grey rows that fall outside plansRoot. */
  relToPlans: string | null;
  kind: ChangeKind;
  /** Source path for renames. */
  oldPath: string | null;
}

export interface ConflictedFile {
  path: string;
  relToPlans: string | null;
}

export type InProgressOp =
  | "none"
  | "merge"
  | "rebase"
  | "cherry-pick"
  | "revert";

export interface GitStatus {
  inRepo: boolean;
  /** Branch name, or "HEAD" when detached. */
  branch: string;
  detached: boolean;
  /** HEAD short SHA. null pre-initial-commit. */
  shortSha: string | null;
  /** Configured upstream (e.g. "origin/main") if any. */
  upstream: string | null;
  ahead: number;
  behind: number;
  /** Working tree has any tracked-or-untracked changes. */
  dirty: boolean;
  conflicts: ConflictedFile[];
  changes: ChangedFile[];
  inProgress: InProgressOp;
}

export async function getGitStatus(
  repoHandle?: string | null,
): Promise<GitStatus> {
  return await invoke<GitStatus>("git_status", {
    args: { repoHandle: repoHandle ?? null },
  });
}

export interface BranchEntry {
  name: string;
  isRemote: boolean;
  remote: string | null;
  lastCommitSecs: number;
  lastCommitSubject: string;
  aheadMain: number;
  behindMain: number;
  isCurrent: boolean;
}

export async function getGitBranches(
  includeRemote: boolean,
): Promise<BranchEntry[]> {
  return await invoke<BranchEntry[]>("git_branches", { includeRemote });
}

export interface GitOpError {
  code:
    | "dirty-tree"
    | "non-ff"
    | "main-protected"
    | "conflict"
    | "no-upstream"
    | "in-progress"
    | "no-repo"
    | "untrusted-repo"
    | "branch-mismatch"
    | "invalid-ref"
    | "invalid-path"
    | "auth"
    | "git"
    | "other";
  message: string;
}

export function parseGitError(err: unknown): GitOpError {
  // Tauri stringifies struct errors as the JSON form. Keep a rescue
  // path for plain strings (so unrelated invokes don't crash here).
  if (
    err &&
    typeof err === "object" &&
    "code" in (err as Record<string, unknown>)
  ) {
    return err as GitOpError;
  }
  return { code: "git", message: String(err) };
}

export async function gitCheckout(
  branchName: string,
  trackRemote = false,
): Promise<void> {
  await invoke("git_checkout", { branchName, trackRemote });
}

export async function gitCreateBranch(
  name: string,
  base: string | null = null,
): Promise<void> {
  await invoke("git_create_branch", { name, base });
}

export async function gitInit(): Promise<void> {
  await invoke("git_init");
}

export interface CommitResult {
  sha: string;
  shortSha: string;
}

export async function gitCommit(
  message: string,
  paths: string[],
): Promise<CommitResult> {
  return await invoke<CommitResult>("git_commit", { message, paths });
}

export async function gitDiscardFile(path: string): Promise<void> {
  await invoke("git_discard_file", { path });
}

export interface PulledCommit {
  sha: string;
  shortSha: string;
  author: string;
  subject: string;
  timeSecs: number;
}

export interface PullSummary {
  commits: PulledCommit[];
  upToDate: boolean;
}

export async function gitPull(
  mode: "ff-only" | "rebase" = "ff-only",
  repoHandle?: string | null,
  expectedBranch?: string | null,
): Promise<PullSummary> {
  return await invoke<PullSummary>("git_pull", {
    mode,
    args: {
      repoHandle: repoHandle ?? null,
      expectedBranch: expectedBranch ?? null,
    },
  });
}

export async function gitPush(
  allowMain = true,
  repoHandle?: string | null,
  expectedBranch?: string | null,
): Promise<void> {
  await invoke("git_push", {
    allowMain,
    args: {
      repoHandle: repoHandle ?? null,
      expectedBranch: expectedBranch ?? null,
    },
  });
}

export async function gitAbortMerge(): Promise<void> {
  await invoke("git_abort_merge");
}

export async function gitFetch(
  repoHandle?: string | null,
  manual = false,
): Promise<boolean> {
  return await invoke<boolean>("git_fetch", {
    args: { repoHandle: repoHandle ?? null, manual },
  });
}

export interface PerRootGitSettings {
  branchPrefix: string | null;
  allowDirectPushToMain: boolean | null;
}

export async function getPerRootGitSettings(): Promise<PerRootGitSettings> {
  return await invoke<PerRootGitSettings>("git_get_per_root_settings");
}

export async function setPerRootGitSettings(
  settings: PerRootGitSettings,
): Promise<void> {
  await invoke("git_set_per_root_settings", { settings });
}

export function onGitFetchComplete(
  handler: (ok: boolean) => void,
): Promise<UnlistenFn> {
  return listen<boolean>("git-fetch-complete", (e) => handler(e.payload));
}

/** "Do you trust this folder?" decision for the active plans-root.
 *  `null` decision means no answer yet — the renderer should prompt. */
export type TrustDecision = "trusted" | "untrusted";

export interface LinkedRepoTrustTarget {
  handle: string;
  path: string;
  configuredPath: string;
}

export interface LinkedRepoTrustEntry extends LinkedRepoTrustTarget {
  decision: TrustDecision | null;
}

export interface WorkspaceTrustState {
  decision: TrustDecision | null;
  linkedRepos: LinkedRepoTrustEntry[];
  pendingLinkedRepos: LinkedRepoTrustTarget[];
}

export async function getWorkspaceTrust(): Promise<WorkspaceTrustState> {
  return await invoke<WorkspaceTrustState>("get_workspace_trust");
}

export async function setWorkspaceTrust(
  decision: TrustDecision | null,
  options: {
    applyRoot?: boolean;
    applyPendingLinkedRepos?: boolean;
  } = {},
): Promise<void> {
  await invoke("set_workspace_trust", {
    decision,
    applyRoot: options.applyRoot ?? null,
    applyPendingLinkedRepos: options.applyPendingLinkedRepos ?? null,
  });
}

export function onWorkspaceTrustChanged(
  handler: (state: WorkspaceTrustState) => void,
): Promise<UnlistenFn> {
  return listen<WorkspaceTrustState>("trust-changed", (e) =>
    handler(e.payload),
  );
}

export type WorkspaceStatusCategory =
  | "draft"
  | "active"
  | "review"
  | "blocked"
  | "done";

export interface WorkspaceStatus {
  key: string;
  label: string;
  category: WorkspaceStatusCategory;
  terminal?: boolean;
}

export interface WorkspaceConfig {
  schema_version: string;
  statuses: WorkspaceStatus[];
  review_required_signoffs: number;
  default_status: string;
  repos?: Record<string, string>;
}

export type WorkspaceConfigSource = "file" | "default";

export interface WorkspaceConfigSnapshot {
  config: WorkspaceConfig;
  exists: boolean;
  path: string;
  source: WorkspaceConfigSource;
}

export interface WorkspaceConfigSourceSnapshot {
  exists: boolean;
  path: string;
  source: string;
}

export type WorkspaceConfigStyle =
  | "defaults"
  | "lightweight"
  | "full-review-flow";

export interface WorkspaceConfigChangeEvent {
  path: string;
  kind: "created" | "modified" | "removed";
}

export async function getWorkspaceConfig(
  plansRoot?: string | null,
): Promise<WorkspaceConfigSnapshot> {
  return await invoke<WorkspaceConfigSnapshot>("get_workspace_config", {
    plansRoot: plansRoot ?? null,
  });
}

export async function writeWorkspaceConfig(
  style: WorkspaceConfigStyle,
  plansRoot?: string | null,
  overwrite = false,
): Promise<WorkspaceConfigSnapshot> {
  return await invoke<WorkspaceConfigSnapshot>("write_workspace_config", {
    style,
    plansRoot: plansRoot ?? null,
    overwrite,
  });
}

export async function readWorkspaceConfigSource(
  plansRoot?: string | null,
): Promise<WorkspaceConfigSourceSnapshot> {
  return await invoke<WorkspaceConfigSourceSnapshot>(
    "read_workspace_config_source",
    {
      plansRoot: plansRoot ?? null,
    },
  );
}

export async function writeWorkspaceConfigSource(
  source: string,
  plansRoot?: string | null,
): Promise<WorkspaceConfigSnapshot> {
  return await invoke<WorkspaceConfigSnapshot>(
    "write_workspace_config_source",
    {
      source,
      plansRoot: plansRoot ?? null,
    },
  );
}

export function onWorkspaceConfigChanged(
  handler: (event: WorkspaceConfigChangeEvent) => void,
): Promise<UnlistenFn> {
  return listen<WorkspaceConfigChangeEvent>(
    "workspace-config-changed",
    (event) => handler(event.payload),
  );
}

/** Cheap repo-dirtiness probe — true iff the working tree has tracked
 *  changes vs. HEAD. Used by the diff explorer to decide whether to
 *  pin the synthetic Unstaged row at the top of the commit rail. */
export async function getHasUncommittedChanges(
  repoHandle?: string | null,
): Promise<boolean> {
  return await invoke<boolean>("git_has_uncommitted", {
    args: { repoHandle: repoHandle ?? null },
  });
}

/** Full-repo commit graph + plan-relevance overlay.
 *
 *  The graph drives the rail's lane rendering (one row per commit,
 *  with lane glyphs computed frontend-side from `parents`). The
 *  overlay drives row highlighting — same union of file-touch +
 *  frontmatter branches + explicit SHAs that the per-plan history
 *  uses, applied as marks rather than an inclusion filter so unrelated
 *  commits stay visible for context. */
export type CommitSource = "file-touch" | "branch" | "explicit";

export interface GraphCommit {
  sha: string;
  shortSha: string;
  /** Full SHAs of every parent. Empty for the initial commit; one for
   *  ordinary commits; two+ for merges (octopus included). */
  parents: string[];
  authorName: string;
  authorEmail: string;
  /** Unix epoch seconds (author time, stable across rebases). */
  timeSecs: number;
  subject: string;
}

export interface PlanRelevance {
  sha: string;
  source: CommitSource;
  /** When source = "branch", the frontmatter branch this commit was
   *  reached from. Used by the rail to decorate the branch label. */
  branch: string | null;
}

export interface CommitGraphResponse {
  commits: GraphCommit[];
  planRelevance: PlanRelevance[];
}

export async function getCommitGraph(args: {
  planRel?: string | null;
  branches?: string[];
  commitShas?: string[];
  repoHandle?: string | null;
  reviewBranch?: string | null;
  reviewBase?: string | null;
  limit?: number;
  beforeSha?: string | null;
}): Promise<CommitGraphResponse> {
  return await invoke<CommitGraphResponse>("git_log_graph", {
    args: {
      planRel: args.planRel ?? null,
      branches: args.branches ?? [],
      commitShas: args.commitShas ?? [],
      repoHandle: args.repoHandle ?? null,
      reviewBranch: args.reviewBranch ?? null,
      reviewBase: args.reviewBase ?? null,
      limit: args.limit ?? null,
      beforeSha: args.beforeSha ?? null,
    },
  });
}

/** A single ref (local branch, remote-tracking branch, or tag) plus
 *  metadata the rail needs to style it (`isHead` for the filled chip
 *  treatment, `isDefaultBranch` for the outlined chip). */
export type RefKind = "branch" | "remote" | "tag";

export interface RefEntry {
  name: string;
  kind: RefKind;
  /** Full SHA the ref points at right now. */
  targetSha: string;
  isHead: boolean;
  isDefaultBranch: boolean;
}

export async function getGitRefs(
  repoHandle?: string | null,
): Promise<RefEntry[]> {
  return await invoke<RefEntry[]>("git_refs", {
    args: { repoHandle: repoHandle ?? null },
  });
}

/** Per-commit detail — full hunks, file list, message body. */
export type FileStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied";

export type DiffLineKind = "context" | "addition" | "deletion";

export interface DiffLine {
  kind: DiffLineKind;
  oldLine: number | null;
  newLine: number | null;
  text: string;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  headerText: string;
  lines: DiffLine[];
}

export interface FileChange {
  status: FileStatus;
  path: string;
  oldPath: string | null;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
  binary: boolean;
  /** When set, the diff body was truncated and this many lines were
   *  dropped from the tail. UI surfaces a "Diff truncated" footer. */
  truncatedLines: number | null;
  /** True when the file's diff crosses the soft cap. UI default-
   *  collapses these like GitHub does for large diffs. */
  large: boolean;
  /** False for commit-header placeholders whose hunks have not been
   *  fetched yet. Unstaged and loaded commit files omit this or set true. */
  bodyLoaded?: boolean;
}

export interface CommitDetail {
  sha: string;
  shortSha: string;
  authorName: string;
  authorEmail: string;
  timeSecs: number;
  subject: string;
  body: string;
  files: FileChange[];
  /** True when the commit's file count exceeded the per-diff cap and
   *  the tail entries were dropped before parsing. */
  truncatedFiles?: boolean;
}

export interface FileChangeHeader {
  status: FileStatus;
  path: string;
  oldPath: string | null;
  additions: number;
  deletions: number;
  binary: boolean;
  truncatedLines: number | null;
  large: boolean;
}

export interface CommitFileHeadersResponse {
  sha: string;
  shortSha: string;
  authorName: string;
  authorEmail: string;
  timeSecs: number;
  subject: string;
  body: string;
  files: FileChangeHeader[];
  /** True when the commit touched more than `MAX_FILES_PER_DIFF`
   *  files and the tail was dropped before parsing. */
  truncatedFiles: boolean;
}

export async function getCommitDetail(
  sha: string,
  repoHandle?: string | null,
): Promise<CommitDetail> {
  return await invoke<CommitDetail>("git_show_commit", {
    args: { sha, repoHandle: repoHandle ?? null },
  });
}

export async function getCommitFileHeaders(
  sha: string,
  repoHandle?: string | null,
): Promise<CommitFileHeadersResponse> {
  return await invoke<CommitFileHeadersResponse>("git_show_commit_files", {
    args: { sha, repoHandle: repoHandle ?? null },
  });
}

export async function getCommitFile(args: {
  sha: string;
  path: string;
  oldPath?: string | null;
  repoHandle?: string | null;
}): Promise<FileChange> {
  return await invoke<FileChange>("git_show_commit_file", {
    args: {
      sha: args.sha,
      path: args.path,
      oldPath: args.oldPath ?? null,
      repoHandle: args.repoHandle ?? null,
    },
  });
}

export async function getUnstagedDetail(
  repoHandle?: string | null,
): Promise<CommitDetail> {
  return await invoke<CommitDetail>("git_status_unstaged", {
    args: { repoHandle: repoHandle ?? null },
  });
}

export interface SearchHit {
  line: number;
  lineText: string;
  matchStart: number;
  matchEnd: number;
}

export interface SearchResult {
  path: string;
  hits: SearchHit[];
}

export interface SearchPlansOptions {
  caseSensitive?: boolean;
  wholeWord?: boolean;
  useRegex?: boolean;
}

export async function searchPlans(
  query: string,
  options: SearchPlansOptions = {},
): Promise<SearchResult[]> {
  return await invoke<SearchResult[]>("search_plans", {
    query,
    caseSensitive: options.caseSensitive ?? false,
    wholeWord: options.wholeWord ?? false,
    useRegex: options.useRegex ?? false,
  });
}

export function onPlanChanged(
  handler: (event: PlanChangeEvent) => void,
): Promise<UnlistenFn> {
  return listen<PlanChangeEvent>("plan-changed", (event) =>
    handler(event.payload),
  );
}

/** Fired when the plans root changes (via the menu, CLI, env, or set_plans_root). */
export function onPlansRootChanged(
  handler: (newPath: string) => void,
): Promise<UnlistenFn> {
  return listen<string>("plans-root-changed", (event) =>
    handler(event.payload),
  );
}

// ─── Pins ────────────────────────────────────────────────────────────

export interface PinnedPlan {
  planPath: string;
  /** Unix epoch seconds. */
  pinnedAt: number;
}

export interface PinnedSection {
  headingId: string;
  /** Heading text at pin time — kept alongside the slug so a future
   *  cross-plan view can render labels without loading every plan. */
  headingText: string;
  pinnedAt: number;
}

export interface Pins {
  plans: PinnedPlan[];
  /** Plan path → pinned sections inside that plan. */
  sections: Record<string, PinnedSection[]>;
}

export async function getPins(): Promise<Pins> {
  return await invoke<Pins>("get_pins");
}

export async function togglePlanPin(planPath: string): Promise<boolean> {
  return await invoke<boolean>("toggle_plan_pin", { planPath });
}

export async function toggleSectionPin(args: {
  planPath: string;
  headingId: string;
  headingText: string;
}): Promise<boolean> {
  return await invoke<boolean>("toggle_section_pin", args);
}

/** Fired by the Rust side when pins change in any window whose
 *  plansRoot canonicalizes to the same path as ours. */
export function onPinsChanged(
  handler: (pins: Pins) => void,
): Promise<UnlistenFn> {
  return listen<Pins>("pins-changed", (e) => handler(e.payload));
}

export interface CustomThemeRaw {
  id: string;
  name: string;
  type: "light" | "dark";
  author?: string;
  variables: Record<string, string>;
  sourcePath?: string;
}

export async function listCustomThemes(): Promise<CustomThemeRaw[]> {
  return await invoke<CustomThemeRaw[]>("list_custom_themes");
}

export function onThemesChanged(handler: () => void): Promise<UnlistenFn> {
  return listen("themes-changed", () => handler());
}

export interface CachedFont {
  family: string;
  slug: string;
  /** Already-rewritten CSS where url(...) points at specrider-font://. */
  css: string;
}

/** Downloads and caches the Google Fonts CSS + woff2 files for `family`
 *  to `<app_config>/fonts/`. Subsequent launches read from the cache;
 *  no network required. */
export async function cacheFont(family: string): Promise<CachedFont> {
  return await invoke<CachedFont>("cache_font", { family });
}

export async function readCachedFont(
  family: string,
): Promise<CachedFont | null> {
  return await invoke<CachedFont | null>("read_cached_font", { family });
}

// ---------------------------------------------------------------------------
// Embedded agent terminal.
// Thin TS wrappers over the terminal_* Tauri commands and helpers for
// subscribing to terminal-* events.
// ---------------------------------------------------------------------------

export type AgentKind = "claude" | "codex" | "shell";

export interface SessionMeta {
  id: string;
  windowLabel: string;
  cwd: string;
  agentKind: AgentKind;
  cols: number;
  rows: number;
  planPath: string | null;
  taskId: string | null;
  worktree: string | null;
}

export interface TerminalOutputEvent {
  sessionId: string;
  /** Base64-encoded raw PTY bytes; decode with atob+Uint8Array before
   *  feeding into xterm.js's Terminal.write(). */
  chunkB64: string;
}

export interface TerminalExitedEvent {
  sessionId: string;
  exitCode: number | null;
}

export interface TerminalErrorEvent {
  sessionId: string;
  message: string;
}

export interface TerminalCwdPayload {
  cwd: string;
}

function bytesToBase64(bytes: Uint8Array): string {
  // btoa works on latin-1 strings; chunk the conversion so we don't
  // overflow the call stack on large pastes.
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, Math.min(i + CHUNK, bytes.length));
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export async function terminalStart(args: {
  cwd: string;
  agentKind: AgentKind;
  cols: number;
  rows: number;
}): Promise<SessionMeta> {
  return await invoke<SessionMeta>("terminal_start", {
    args: {
      cwd: args.cwd,
      agent_kind: args.agentKind,
      cols: args.cols,
      rows: args.rows,
    },
  });
}

export async function terminalResolveCwd(args: {
  plansRoot?: string | null;
  repoHandle?: string | null;
}): Promise<TerminalCwdPayload> {
  return await invoke<TerminalCwdPayload>("terminal_resolve_cwd", {
    args: {
      plans_root: args.plansRoot ?? null,
      repo_handle: args.repoHandle ?? null,
    },
  });
}

export async function terminalWrite(
  sessionId: string,
  bytes: Uint8Array | string,
): Promise<void> {
  const b64 =
    typeof bytes === "string"
      ? bytesToBase64(new TextEncoder().encode(bytes))
      : bytesToBase64(bytes);
  await invoke("terminal_write", {
    args: { session_id: sessionId, bytes_b64: b64 },
  });
}

export async function terminalSetCwd(
  sessionId: string,
  cwd: string,
): Promise<void> {
  await invoke("terminal_set_cwd", {
    args: { session_id: sessionId, cwd },
  });
}

export async function terminalResize(
  sessionId: string,
  cols: number,
  rows: number,
): Promise<void> {
  await invoke("terminal_resize", {
    args: { session_id: sessionId, cols, rows },
  });
}

export async function terminalKill(sessionId: string): Promise<void> {
  await invoke("terminal_kill", { args: { session_id: sessionId } });
}

export async function terminalReplay(sessionId: string): Promise<Uint8Array> {
  const res = await invoke<{ bytes_b64: string }>("terminal_replay", {
    args: { session_id: sessionId },
  });
  return base64ToBytes(res.bytes_b64);
}

export async function listTerminalSessions(): Promise<SessionMeta[]> {
  return await invoke<SessionMeta[]>("list_terminal_sessions");
}

export function onTerminalOutput(
  handler: (e: TerminalOutputEvent) => void,
): Promise<UnlistenFn> {
  return listen<{ session_id: string; chunk_b64: string }>(
    "terminal-output",
    (e) =>
      handler({
        sessionId: e.payload.session_id,
        chunkB64: e.payload.chunk_b64,
      }),
  );
}

export function onTerminalExited(
  handler: (e: TerminalExitedEvent) => void,
): Promise<UnlistenFn> {
  return listen<{ session_id: string; exit_code: number | null }>(
    "terminal-exited",
    (e) =>
      handler({
        sessionId: e.payload.session_id,
        exitCode: e.payload.exit_code,
      }),
  );
}

export function onTerminalError(
  handler: (e: TerminalErrorEvent) => void,
): Promise<UnlistenFn> {
  return listen<{ session_id: string; message: string }>(
    "terminal-error",
    (e) =>
      handler({ sessionId: e.payload.session_id, message: e.payload.message }),
  );
}

export function onTerminalSessionsChanged(
  handler: () => void,
): Promise<UnlistenFn> {
  return listen("terminal-sessions-changed", () => handler());
}

export interface DiagnosticsSnapshot {
  appVersion: string;
  tauriVersion: string;
  os: string;
  osVersion: string;
  arch: string;
  targetTriple: string;
  webview: string;
  locale: string;
  /** Whether a plans root is bound to the calling window. The path
   *  itself is deliberately omitted (folder names can be sensitive). */
  plansRootBound: boolean;
  /** `"trusted" | "untrusted" | "not-set" | "no-root"`. */
  workspaceTrust: string;
  /** Number of project (non-Settings) windows currently open. */
  windowsOpen: number;
  /** Full settings object — every user override the app has persisted,
   *  excluding null/unset fields (which mean "still on the default").
   *  `defaultPlansRoot` is reduced to a `defaultPlansRootSet` boolean
   *  so the snapshot doesn't carry the user's chosen folder path. */
  settings: Record<string, unknown>;
  featureFlags: string[];
  /** Fenced markdown block ready to paste into a GitHub issue. */
  markdown: string;
}

/** Returns the diagnostic-info snapshot for the calling window. The
 *  payload includes a pre-rendered `markdown` field that's safe to drop
 *  into `navigator.clipboard.writeText`. */
export async function diagnosticsSnapshot(): Promise<DiagnosticsSnapshot> {
  return await invoke<DiagnosticsSnapshot>("diagnostics_snapshot");
}
