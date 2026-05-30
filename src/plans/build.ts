import type { PlanTitleSource } from "../settings/types";
import type { PlanFileMeta } from "../tauri/api";
import type {
  Bucket,
  FrontmatterIssue,
  LinkedRepoLink,
  Plan,
  PlanStatus,
} from "../types";

const SELF_REPO_HANDLE = "self";

const VALID_STATUSES: ReadonlySet<PlanStatus> = new Set([
  "in-progress",
  "draft",
  "shipped",
]);

/**
 * Builds a Plan from filesystem metadata + parsed frontmatter + content
 * metrics returned by `list_plans`. Frontmatter `title` always wins;
 * `titleSource` only controls the fallback when frontmatter is absent.
 */
export function planFromFile(
  f: PlanFileMeta,
  titleSource: PlanTitleSource = "heading",
  workspaceRepoHandles: readonly string[] = [],
): Plan {
  const segments = f.path.split("/").filter(Boolean);
  const bucket: Bucket =
    segments.length > 1 ? segments[segments.length - 2] : "loose";
  const filename = segments[segments.length - 1] ?? f.path;
  const stem = filename.replace(/\.md$/i, "");

  const fm = f.frontmatter ?? {};

  const fmTitle = stringField(fm.title);
  const fmStatus = stringField(fm.status);
  const fmOwner = stringField(fm.owner);
  const fmIteration = numberField(fm.iteration);
  const fmTags = stringArrayField(fm.tags);
  const fmContributors = stringArrayField(fm.contributors);
  const fmBranches = stringArrayField(fm.branches);
  const fmCommits = stringArrayField(fm.commits);
  const { links: linkedRepoLinks, issues: linkIssues } = linksField(
    fm.links,
    workspaceRepoHandles,
  );

  // Only honor frontmatter — no bucket-derived fallback. The reader's
  // status pill and the browser's "shipped" styling now key off
  // `bucket` instead of derived status, so absence of a frontmatter
  // status simply means "no badge to show."
  const status: PlanStatus | null =
    fmStatus && VALID_STATUSES.has(fmStatus as PlanStatus)
      ? (fmStatus as PlanStatus)
      : null;

  const ago = Math.max(0, Math.floor(Date.now() / 1000) - f.modifiedSecs);
  const readMinutes =
    f.wordCount > 0 ? Math.max(1, Math.ceil(f.wordCount / 220)) : 0;

  const fallbackTitle =
    titleSource === "heading" && f.h1 && f.h1.length > 0
      ? f.h1
      : titleFromStem(stem);

  return {
    id: f.path,
    title: fmTitle ?? fallbackTitle,
    path: f.path,
    bucket,
    modifiedAt: humanizeAgo(ago, f.modifiedSecs),
    modifiedRaw: ago,
    lineCount: f.lineCount,
    wordCount: f.wordCount,
    readMinutes,
    status,
    owner: fmOwner ?? "",
    contributors: fmContributors ?? [],
    progress: { done: f.taskDone, total: f.taskTotal },
    tags: fmTags ?? [],
    iterationCount: fmIteration ?? 0,
    gitBranches: fmBranches ?? [],
    gitCommits: fmCommits ?? [],
    linkedRepoLinks,
    frontmatterIssues: linkIssues,
  };
}

function stringField(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function numberField(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function stringArrayField(v: unknown): string[] | null {
  if (Array.isArray(v)) {
    return v.filter((x): x is string => typeof x === "string" && x.length > 0);
  }
  if (typeof v === "string" && v.length > 0) {
    // Single string → one-element array (tolerant of `tags: foo`)
    return [v];
  }
  return null;
}

function linksField(
  v: unknown,
  workspaceRepoHandles: readonly string[],
): { links: LinkedRepoLink[]; issues: FrontmatterIssue[] } {
  const links: LinkedRepoLink[] = [];
  const issues: FrontmatterIssue[] = [];

  if (v == null) return { links, issues };
  if (!Array.isArray(v)) {
    issues.push({
      field: "links",
      message: "`links` must be a list of repo/branch objects.",
    });
    return { links, issues };
  }

  const knownRepos = new Set(
    [SELF_REPO_HANDLE, ...workspaceRepoHandles]
      .map((handle) => handle.trim())
      .filter((handle) => handle.length > 0),
  );

  for (const [index, rawLink] of v.entries()) {
    const field = `links[${index}]`;
    const item = objectField(rawLink);
    if (!item) {
      issues.push({
        field,
        message: `${field} must be an object with repo and branch.`,
      });
      continue;
    }

    const itemIssues: FrontmatterIssue[] = [];
    const repo = trimmedStringField(item.repo);
    const branch = trimmedStringField(item.branch);
    const base = item.base == null ? "main" : trimmedStringField(item.base);

    if (!repo) {
      itemIssues.push({
        field: `${field}.repo`,
        message: `${field}.repo is required.`,
      });
    } else if (!knownRepos.has(repo)) {
      itemIssues.push({
        field: `${field}.repo`,
        message: `Unknown linked repo handle "${repo}".`,
      });
    }

    if (!branch) {
      itemIssues.push({
        field: `${field}.branch`,
        message: `${field}.branch is required.`,
      });
    }

    if (!base) {
      itemIssues.push({
        field: `${field}.base`,
        message: `${field}.base must be a non-empty string when provided.`,
      });
    }

    if (itemIssues.length > 0 || !repo || !branch || !base) {
      issues.push(...itemIssues);
      continue;
    }

    links.push({
      repo,
      branch,
      base,
    });
  }

  return { links, issues };
}

function objectField(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v != null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function trimmedStringField(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function titleFromStem(stem: string): string {
  return stem
    .replace(/^[_-]+/, "")
    .replace(/[-_]+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function humanizeAgo(secsAgo: number, modifiedSecs: number): string {
  if (secsAgo < 60) return "just now";
  if (secsAgo < 3600) return `${Math.floor(secsAgo / 60)}m ago`;
  if (secsAgo < 86400) return `${Math.floor(secsAgo / 3600)}h ago`;
  if (secsAgo < 7 * 86400) return `${Math.floor(secsAgo / 86400)}d ago`;
  const d = new Date(modifiedSecs * 1000);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
