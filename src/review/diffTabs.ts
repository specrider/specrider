import type { LinkedRepoLink } from "../types";

export const DOCS_REVIEW_TAB_ID = "docs";

export type DiffReviewTab =
  | {
      id: typeof DOCS_REVIEW_TAB_ID;
      kind: "docs";
      label: string;
      repoPath: string | null;
    }
  | {
      id: string;
      kind: "linked";
      label: string;
      repo: string;
      branch: string;
      base: string;
      repoPath: string | null;
    };

interface BuildDiffReviewTabsOptions {
  plansRoot?: string | null;
  workspaceRepos?: Readonly<Record<string, string>>;
}

export function buildDiffReviewTabs(
  links: readonly LinkedRepoLink[],
  options: BuildDiffReviewTabsOptions = {},
): DiffReviewTab[] {
  return [
    {
      id: DOCS_REVIEW_TAB_ID,
      kind: "docs",
      label: "docs",
      repoPath: options.plansRoot ?? null,
    },
    ...links.map((link, index) => ({
      id: linkedTabId(link, index),
      kind: "linked" as const,
      label: `${link.repo} @ ${link.branch}`,
      repo: link.repo,
      branch: link.branch,
      base: link.base,
      repoPath: linkedRepoPath(link.repo, options),
    })),
  ];
}

export function hasDiffReviewTab(
  tabs: readonly DiffReviewTab[],
  tabId: string,
): boolean {
  return tabs.some((tab) => tab.id === tabId);
}

function linkedTabId(link: LinkedRepoLink, index: number): string {
  return `linked:${index}:${link.repo}:${link.base}:${link.branch}`;
}

function linkedRepoPath(
  repo: string,
  options: BuildDiffReviewTabsOptions,
): string | null {
  if (repo === "self") return options.plansRoot ?? null;
  const configuredPath = options.workspaceRepos?.[repo];
  if (!configuredPath) return null;
  return resolveWorkspaceRepoPath(options.plansRoot ?? null, configuredPath);
}

export function resolveWorkspaceRepoPath(
  plansRoot: string | null,
  configuredPath: string,
): string {
  const trimmed = configuredPath.trim();
  if (!plansRoot || isAbsolutePath(trimmed)) return normalizeFsPath(trimmed);
  return normalizeFsPath(`${stripTrailingSeparators(plansRoot)}/${trimmed}`);
}

function isAbsolutePath(path: string): boolean {
  return (
    path.startsWith("/") ||
    path.startsWith("\\\\") ||
    /^[A-Za-z]:[\\/]/.test(path)
  );
}

function stripTrailingSeparators(path: string): string {
  return path.replace(/[\\/]+$/, "");
}

function normalizeFsPath(path: string): string {
  const useBackslash = /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
  const sep = useBackslash ? "\\" : "/";
  const driveMatch = path.match(/^([A-Za-z]:)[\\/]/);
  const drive = driveMatch?.[1] ?? "";
  const isUnc = path.startsWith("\\\\");
  const absolute = isUnc || path.startsWith("/") || drive.length > 0;
  const prefix = isUnc
    ? "\\\\"
    : drive
      ? `${drive}\\`
      : path.startsWith("/")
        ? "/"
        : "";
  const withoutPrefix = drive
    ? path.slice(drive.length + 1)
    : isUnc
      ? path.replace(/^\\+/, "")
      : path.replace(/^\/+/, "");
  const parts: string[] = [];

  for (const rawPart of withoutPrefix.split(/[\\/]+/)) {
    if (!rawPart || rawPart === ".") continue;
    if (rawPart === "..") {
      if (parts.length > 0 && parts[parts.length - 1] !== "..") {
        parts.pop();
      } else if (!absolute) {
        parts.push(rawPart);
      }
      continue;
    }
    parts.push(rawPart);
  }

  return `${prefix}${parts.join(sep)}` || ".";
}
