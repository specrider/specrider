import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { expect, type Page, test } from "@playwright/test";

interface PlanFileMeta {
  path: string;
  modifiedSecs: number;
  size: number;
  lineCount: number;
  wordCount: number;
  taskDone: number;
  taskTotal: number;
  frontmatter: Record<string, unknown> | null;
  h1: string | null;
}

interface GraphCommit {
  sha: string;
  shortSha: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  timeSecs: number;
  subject: string;
}

interface RefEntry {
  name: string;
  kind: "branch" | "remote" | "tag";
  targetSha: string;
  isHead: boolean;
  isDefaultBranch: boolean;
}

interface DiffLine {
  kind: "context" | "addition" | "deletion";
  oldLine: number | null;
  newLine: number | null;
  text: string;
}

interface FileChange {
  status: "added" | "modified" | "deleted" | "renamed" | "copied";
  path: string;
  oldPath: string | null;
  additions: number;
  deletions: number;
  hunks: Array<{
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    headerText: string;
    lines: DiffLine[];
  }>;
  binary: boolean;
  truncatedLines: number | null;
  large: boolean;
  bodyLoaded?: boolean;
}

interface CommitDetail {
  sha: string;
  shortSha: string;
  authorName: string;
  authorEmail: string;
  timeSecs: number;
  subject: string;
  body: string;
  files: FileChange[];
}

interface FixtureData {
  root: string;
  homeDir: string;
  planRel: string;
  plans: PlanFileMeta[];
  planContents: Record<string, string>;
  commits: GraphCommit[];
  refs: RefEntry[];
  branch: string;
  shortSha: string;
  largeDiffDetail: CommitDetail;
  emptyUnstagedDetail: CommitDetail;
  settings: Record<string, unknown>;
  gitStatus: Record<string, unknown>;
}

const repoRoot = process.cwd();
const fcpBudgetMs = Number(process.env.PERF_FCP_BUDGET_MS ?? 200);
const fpsBudget = Number(process.env.PERF_FPS_BUDGET ?? 55);
const diffLineCount = Number(process.env.PERF_DIFF_LINES ?? 1000);

let fixtureRootForCleanup: string | null = null;
let fixtureData: FixtureData;

test.beforeAll(() => {
  const root = process.env.PERF_FIXTURE_REPO ?? createPerfFixtureRepo();
  fixtureData = buildFixtureData(root);
});

test.afterAll(() => {
  if (fixtureRootForCleanup) {
    rmSync(fixtureRootForCleanup, { recursive: true, force: true });
  }
});

test.beforeEach(async ({ page }) => {
  await installTauriMock(page, fixtureData);
});

test("commit rail keeps the 500-commit fixture above the FPS budget", async ({
  page,
}) => {
  await openFixture(page);
  const fcp = await firstContentfulPaint(page);
  expect(fcp, `first contentful paint was ${fcp} ms`).toBeLessThanOrEqual(
    fcpBudgetMs,
  );

  await openDiffExplorer(page);
  await expect(page.locator(".ch-row-graph").first()).toBeVisible();
  const rowCount = await page.locator(".ch-row-graph").count();
  expect(
    rowCount,
    "rail should virtualize to a small mounted row set",
  ).toBeLessThan(80);

  const rail = await measureScrollFps(page, ".ch-graph");
  expect(rail.fps, `commit rail FPS: ${rail.fps}`).toBeGreaterThanOrEqual(
    fpsBudget,
  );
});

test("diff viewer keeps the 1000-line diff above the FPS budget", async ({
  page,
}) => {
  await openFixture(page);
  await openDiffExplorer(page);

  await expect(page.locator(".diff-explorer-title")).toContainText(
    "Large 1000 line diff fixture",
  );
  await expect(page.locator(".cdb-file-head")).toContainText(
    "src/large-diff.txt",
  );
  await expect(page.locator(".cdb-line").first()).toBeVisible();

  const diff = await measureScrollFps(page, ".diff-explorer-body");
  expect(diff.fps, `diff viewer FPS: ${diff.fps}`).toBeGreaterThanOrEqual(
    fpsBudget,
  );
});

function createPerfFixtureRepo(): string {
  const tmpRoot = mkdtempSync(join(tmpdir(), "specrider-perf-"));
  fixtureRootForCleanup = tmpRoot;
  const target = join(tmpRoot, "fixture");
  execFileSync("bash", [join(repoRoot, "scripts/perf-fixture.sh"), target], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PERF_COMMITS: process.env.PERF_COMMITS ?? "520",
      PERF_MARKDOWN_LINES: process.env.PERF_MARKDOWN_LINES ?? "5000",
      PERF_DIFF_LINES: String(diffLineCount),
    },
    stdio: "pipe",
  });
  return target;
}

function buildFixtureData(root: string): FixtureData {
  const plans = walk(root)
    .filter((path) => path.endsWith(".md"))
    .map((path) => planMeta(root, path))
    .sort((a, b) => a.path.localeCompare(b.path));
  const largePlanRel =
    plans.find((plan) => plan.path.endsWith("perf-fixture.md"))?.path ??
    plans[0]?.path;
  if (!largePlanRel) throw new Error(`No Markdown fixture found under ${root}`);
  const startupPlanRel =
    plans.find((plan) => plan.path === "README.md")?.path ?? largePlanRel;

  const planContents = Object.fromEntries(
    plans.map((plan) => [
      plan.path,
      readFileSync(join(root, plan.path), "utf8"),
    ]),
  );
  const commits = git(root, [
    "log",
    "--all",
    "--max-count=700",
    "--pretty=format:%H%x1f%h%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%s",
  ])
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [
        sha,
        shortSha,
        parents,
        authorName,
        authorEmail,
        timeSecs,
        subject,
      ] = line.split("\x1f");
      return {
        sha,
        shortSha,
        parents: parents ? parents.split(" ").filter(Boolean) : [],
        authorName,
        authorEmail,
        timeSecs: Number(timeSecs),
        subject,
      };
    });
  if (commits.length === 0) throw new Error("Fixture repo has no commits");

  const branch = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const head = commits[0];
  const refs: RefEntry[] = [
    {
      name: branch,
      kind: "branch",
      targetSha: head.sha,
      isHead: true,
      isDefaultBranch: branch === "main" || branch === "master",
    },
  ];
  const largeDiffFile = makeLargeDiffFile(diffLineCount);
  const largeDiffDetail: CommitDetail = {
    sha: head.sha,
    shortSha: head.shortSha,
    authorName: head.authorName,
    authorEmail: head.authorEmail,
    timeSecs: head.timeSecs,
    subject: head.subject,
    body: "",
    files: [largeDiffFile],
  };
  const emptyUnstagedDetail: CommitDetail = {
    sha: "unstaged",
    shortSha: "unstaged",
    authorName: "Working tree",
    authorEmail: "",
    timeSecs: Math.floor(Date.now() / 1000),
    subject: "Uncommitted changes",
    body: "",
    files: [],
  };

  return {
    root,
    homeDir: process.env.HOME ?? root,
    planRel: startupPlanRel,
    plans,
    planContents,
    commits,
    refs,
    branch,
    shortSha: head.shortSha,
    largeDiffDetail,
    emptyUnstagedDetail,
    settings: rawSettings(root),
    gitStatus: {
      inRepo: true,
      branch,
      detached: false,
      shortSha: head.shortSha,
      upstream: null,
      ahead: 0,
      behind: 0,
      dirty: false,
      conflicts: [],
      changes: [],
      inProgress: "none",
    },
  };
}

function rawSettings(root: string): Record<string, unknown> {
  return {
    theme: null,
    themeLightId: null,
    themeDarkId: null,
    accent: null,
    bodySize: null,
    uiSize: null,
    monoSize: null,
    lineHeight: null,
    density: null,
    fontSerif: "Georgia",
    fontSans: "-apple-system",
    fontMono: "Menlo",
    editorLineNumbers: null,
    editorSoftWrap: null,
    editorTabSize: null,
    defaultPlansRoot: root,
    keepAppAlive: null,
    planTitleSource: "heading",
    hyphenation: null,
    bodyLigatures: null,
    monoLigatures: null,
    showChangeIndicators: false,
    compareAgainst: null,
    showLineBlame: false,
    outlineShowTasks: null,
    outlineShowNumberedLists: null,
    outlineShowBulletedLists: null,
    defaultReaderMode: "edit",
    splitScrollSync: false,
    showCommitGraph: true,
    gitBranchPrefix: "",
    gitPullStrategy: "ff-only",
    gitFetchIntervalSecs: 0,
    gitAllowDirectPushToMain: false,
    gitShowStatusCluster: false,
  };
}

function makeLargeDiffFile(lineCount: number): FileChange {
  const lines: DiffLine[] = [];
  for (let i = 1; i <= lineCount; i++) {
    lines.push({
      kind: "deletion",
      oldLine: i,
      newLine: null,
      text: `original diff line ${String(i).padStart(4, "0")}`,
    });
  }
  for (let i = 1; i <= lineCount; i++) {
    lines.push({
      kind: "addition",
      oldLine: null,
      newLine: i,
      text: `modified diff line ${String(i).padStart(4, "0")}`,
    });
  }
  return {
    status: "modified",
    path: "src/large-diff.txt",
    oldPath: null,
    additions: lineCount,
    deletions: lineCount,
    hunks: [
      {
        oldStart: 1,
        oldLines: lineCount,
        newStart: 1,
        newLines: lineCount,
        headerText: `@@ -1,${lineCount} +1,${lineCount} @@`,
        lines,
      },
    ],
    binary: false,
    truncatedLines: null,
    large: false,
    bodyLoaded: true,
  };
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out;
}

function planMeta(root: string, path: string): PlanFileMeta {
  const rel = relative(root, path).split("\\").join("/");
  const contents = readFileSync(path, "utf8");
  const stats = statSync(path);
  const taskMatches = [...contents.matchAll(/^\s*[-*+]\s+\[[ xX]\]/gm)];
  const doneMatches = [...contents.matchAll(/^\s*[-*+]\s+\[[xX]\]/gm)];
  return {
    path: rel,
    modifiedSecs: Math.floor(stats.mtimeMs / 1000),
    size: stats.size,
    lineCount: contents.length === 0 ? 0 : contents.split(/\r\n|\r|\n/).length,
    wordCount: contents.trim() ? contents.trim().split(/\s+/).length : 0,
    taskDone: doneMatches.length,
    taskTotal: taskMatches.length,
    frontmatter: null,
    h1: contents.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? null,
  };
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function installTauriMock(
  page: Page,
  fixture: FixtureData,
): Promise<void> {
  await page.addInitScript((data) => {
    const callbacks = new Map<number, (payload: unknown) => void>();
    const listeners = new Map<number, { event: string; handler: number }>();
    let nextCallbackId = 1;
    let nextEventId = 1;

    const win = window as Window & {
      __TAURI_INTERNALS__?: unknown;
      __TAURI_EVENT_PLUGIN_INTERNALS__?: unknown;
    };

    win.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
      unregisterListener(_event: string, eventId: number) {
        listeners.delete(eventId);
      },
    };

    win.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" } },
      transformCallback(callback: (payload: unknown) => void, once = false) {
        const id = nextCallbackId++;
        callbacks.set(id, (payload: unknown) => {
          callback(payload);
          if (once) callbacks.delete(id);
        });
        return id;
      },
      unregisterCallback(id: number) {
        callbacks.delete(id);
      },
      async invoke(cmd: string, args: Record<string, unknown> = {}) {
        if (cmd === "plugin:event|listen") {
          const id = nextEventId++;
          listeners.set(id, {
            event: String(args.event),
            handler: Number(args.handler),
          });
          return id;
        }
        if (cmd === "plugin:event|unlisten") {
          listeners.delete(Number(args.eventId));
          return null;
        }
        if (cmd === "plugin:path|resolve_directory") return data.homeDir;
        if (cmd === "plugin:window|set_title") return null;
        if (cmd === "show_window") return null;
        if (cmd === "get_settings") return data.settings;
        if (cmd === "set_setting" || cmd === "reset_settings") return null;
        if (cmd === "list_custom_themes") return [];
        if (cmd === "read_cached_font") return null;
        if (cmd === "cache_font") return null;
        if (cmd === "get_pins") return { plans: [], sections: {} };
        if (cmd === "toggle_plan_pin" || cmd === "toggle_section_pin") {
          return false;
        }
        if (cmd === "get_plans_root") return data.root;
        if (cmd === "set_plans_root") return null;
        if (cmd === "get_initial_state") {
          return { plansRoot: data.root, activePlan: data.planRel };
        }
        if (cmd === "list_plans" || cmd === "analyze_plans") return data.plans;
        if (cmd === "read_plan") {
          const relPath = String(args.relPath);
          return data.planContents[relPath] ?? "";
        }
        if (cmd === "write_plan") return null;
        if (cmd === "diff_plan") {
          return { added: [], modified: [], deletedAfter: [], hunks: [] };
        }
        if (cmd === "list_changed_plans") return [];
        if (cmd === "blame_plan") return { lines: [], commits: {} };
        if (cmd === "git_branch") {
          return {
            name: data.branch,
            detached: false,
            shortSha: data.shortSha,
          };
        }
        if (cmd === "git_status") return data.gitStatus;
        if (cmd === "git_fetch") return true;
        if (cmd === "git_has_uncommitted") return false;
        if (cmd === "git_log_graph") {
          const request = args.args as { limit?: number | null } | undefined;
          const limit = request?.limit ?? data.commits.length;
          return {
            commits: data.commits.slice(0, limit),
            planRelevance: [],
          };
        }
        if (cmd === "git_refs") return data.refs;
        if (cmd === "git_show_commit_files") {
          const sha = (args.args as { sha?: string } | undefined)?.sha;
          const detail =
            sha === data.largeDiffDetail.sha
              ? data.largeDiffDetail
              : emptyCommitDetail(String(sha ?? ""));
          return {
            ...detail,
            files: detail.files.map((file) => ({
              status: file.status,
              path: file.path,
              oldPath: file.oldPath,
              additions: file.additions,
              deletions: file.deletions,
              binary: file.binary,
              truncatedLines: file.truncatedLines,
              large: file.large,
            })),
          };
        }
        if (cmd === "git_show_commit_file")
          return data.largeDiffDetail.files[0];
        if (cmd === "git_show_commit") return data.largeDiffDetail;
        if (cmd === "git_status_unstaged") return data.emptyUnstagedDetail;
        if (cmd === "search_plans") return [];
        if (cmd === "list_terminal_sessions") return [];
        if (
          cmd === "terminal_start" ||
          cmd === "terminal_write" ||
          cmd === "terminal_resize" ||
          cmd === "terminal_kill" ||
          cmd === "terminal_replay"
        ) {
          return null;
        }
        console.warn(`[tauri-mock] unhandled invoke: ${cmd}`, args);
        return null;
      },
    };

    function emptyCommitDetail(sha: string) {
      return {
        sha,
        shortSha: sha.slice(0, 8),
        authorName: "Fixture",
        authorEmail: "fixture@example.invalid",
        timeSecs: Math.floor(Date.now() / 1000),
        subject: "Fixture commit",
        body: "",
        files: [],
      };
    }

    localStorage.setItem("specrider.migrated", "true");
    localStorage.setItem(
      "specrider.windowState.v1.main",
      JSON.stringify({
        browserVisible: false,
        outlineVisible: true,
        readerVisible: true,
        terminalOpen: false,
        diffOpen: false,
        activePlanPath: data.planRel,
      }),
    );
  }, fixture);
}

async function openFixture(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.locator(".tb-plan-title")).toContainText(
    "Specrider perf fixture",
  );
}

async function openDiffExplorer(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Toggle diff explorer" }).click();
  await expect(page.locator(".diff-explorer-pane")).toBeVisible();
  await expect(page.locator(".commit-history-rail")).toBeVisible();
  await expect(page.locator(".ch-row-graph").first()).toBeVisible();
}

async function firstContentfulPaint(page: Page): Promise<number> {
  return await page.evaluate(() => {
    const paint = performance.getEntriesByName("first-contentful-paint")[0] as
      | PerformanceEntry
      | undefined;
    if (paint) return Math.round(paint.startTime);

    const nav = performance.getEntriesByType("navigation")[0] as
      | PerformanceNavigationTiming
      | undefined;
    if (nav) return Math.round(nav.domContentLoadedEventEnd - nav.startTime);

    return Math.round(
      performance.timing.domContentLoadedEventEnd -
        performance.timing.navigationStart,
    );
  });
}

async function measureScrollFps(
  page: Page,
  selector: string,
): Promise<{ fps: number; frames: number; durationMs: number }> {
  return await page.locator(selector).evaluate(async (element, selector) => {
    const scroller = element as HTMLElement;
    const maxScroll = scroller.scrollHeight - scroller.clientHeight;
    if (maxScroll <= 0) {
      throw new Error(`${selector} is not scrollable`);
    }
    scroller.scrollTop = 0;
    const durationMs = 2000;
    const start = performance.now();
    let frames = 0;

    return await new Promise<{
      fps: number;
      frames: number;
      durationMs: number;
    }>((resolve) => {
      const step = (now: number) => {
        frames++;
        const elapsed = now - start;
        const progress = Math.min(1, elapsed / durationMs);
        scroller.scrollTop = maxScroll * progress;
        if (elapsed < durationMs) {
          requestAnimationFrame(step);
          return;
        }
        resolve({
          fps: Math.round((frames / (elapsed / 1000)) * 10) / 10,
          frames,
          durationMs: Math.round(elapsed),
        });
      };
      requestAnimationFrame(step);
    });
  }, selector);
}
