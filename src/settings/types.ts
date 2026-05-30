/** A theme value is either "system" (resolves to themeLightId or
 *  themeDarkId based on prefers-color-scheme) or any theme id from the
 *  bundled catalog (or in the future, a user-supplied custom theme). */
export type ThemeId = string;
export type Density = "comfortable" | "dense";
export type PlanTitleSource = "filename" | "heading";
export type DefaultReaderMode = "read" | "edit" | "split";
export type GitPullStrategy = "ff-only" | "rebase";
/** Workspace-trust policy applied the first time a previously-unseen
 *  plans root is opened. `alwaysAsk` (default) shows the prompt.
 *  `alwaysTrust` / `alwaysUntrust` skip it and persist the
 *  corresponding decision silently. */
export type DefaultTrustPolicy = "alwaysAsk" | "alwaysTrust" | "alwaysUntrust";
/** Updater channel. `pre` is reserved for future opt-in pre-release
 *  subscribers; currently both values resolve to the same endpoint
 *  because the JS `check()` API has no per-call endpoint override. */
export type UpdateChannel = "stable" | "pre";

/** Raw on-disk settings — every field nullable; `null` means "use default". */
export interface AppSettings {
  theme: ThemeId | null;
  themeLightId: ThemeId | null; // active theme when system mode + light
  themeDarkId: ThemeId | null; // active theme when system mode + dark
  accent: string | null;
  bodySize: number | null;
  uiSize: number | null;
  monoSize: number | null;
  lineHeight: number | null;
  density: Density | null;
  fontSerif: string | null;
  fontSans: string | null;
  fontMono: string | null;
  editorLineNumbers: boolean | null;
  editorSoftWrap: boolean | null;
  editorTabSize: number | null;
  defaultPlansRoot: string | null;
  keepAppAlive: boolean | null;
  planTitleSource: PlanTitleSource | null;
  hyphenation: boolean | null;
  bodyLigatures: boolean | null;
  monoLigatures: boolean | null;
  /** Show unstaged-vs-HEAD change markers (gutter, outline dots,
   *  read-mode block stripes, status bar) for plans in a git repo. */
  showChangeIndicators: boolean | null;
  /** Diff baseline. v1 only supports "head"; field exists so future
   *  options ("since-last-view" etc.) don't require a migration. */
  compareAgainst: "head" | null;
  /** Per-line blame annotation in the editor (and ⌘⇧B session
   *  toggle). Off by default — git blame is one shell-out per file
   *  and visually denser than the change indicators. */
  showLineBlame: boolean | null;
  outlineShowTasks: boolean | null;
  outlineShowNumberedLists: boolean | null;
  outlineShowBulletedLists: boolean | null;
  /** What mode new plans open in. */
  defaultReaderMode: DefaultReaderMode | null;
  /** Two-way scroll sync in split mode. */
  splitScrollSync: boolean | null;
  /** Render the lane glyph column in the diff explorer's commit
   *  history rail. Off → rows show only refs / subject / metadata
   *  (denser, more text-focused); on → SVG lanes draw the branch
   *  topology like SourceTree. Default on. */
  showCommitGraph: boolean | null;
  /** New-branch namespace prefix (e.g. "specs/"). Empty disables. */
  gitBranchPrefix: string | null;
  gitPullStrategy: GitPullStrategy | null;
  /** Background fetch interval in seconds. 0 disables. */
  gitFetchIntervalSecs: number | null;
  /** Allow UI pushes to main/master/trunk. Off keeps a local hard block. */
  gitAllowDirectPushToMain: boolean | null;
  /** Ask before UI pushes to main/master/trunk when direct pushes are allowed. */
  gitConfirmDirectPushToMain: boolean | null;
  /** Show the status-bar git cluster. */
  gitShowStatusCluster: boolean | null;
  /** In Tags / Assignees grouping modes, include archive plans
   *  inline by default. Off → archive plans hidden behind a
   *  `+N archived` per-section pill. */
  docsShowArchivedByDefault: boolean | null;
  /** Variant id for the persistent app-icon override. `null` keeps the
   *  bundled `.icns`. Resolves to a PNG under
   *  `Contents/Resources/icons/variants/<id>.png` at apply time. */
  appIcon: string | null;
  /** Mirror canvas-painted terminal output into a hidden textarea so
   *  screen readers can read it. Off by default — synthesizing the
   *  mirror is non-trivial under heavy terminal output. */
  terminalAnnounceOutput: boolean | null;
  /** Workspace-trust policy applied to never-seen plans roots. */
  defaultTrustPolicy: DefaultTrustPolicy | null;
  /** Run the silent updater check 30s after the main window paints.
   *  Off → only manual "Check now" from Settings → System & Updates can trigger
   *  a check. Default on. */
  checkForUpdatesOnLaunch: boolean | null;
  /** Updater channel — see `UpdateChannel`. */
  updateChannel: UpdateChannel | null;
}

/** Effective settings — same shape, but every field has a defined value
 *  with the hardcoded default substituted for `null`. UI controls bind
 *  to this so they always have something to render. */
export interface ResolvedSettings {
  theme: ThemeId;
  themeLightId: ThemeId;
  themeDarkId: ThemeId;
  accent: string | null;
  bodySize: number;
  uiSize: number;
  monoSize: number;
  lineHeight: number;
  density: Density;
  fontSerif: string;
  fontSans: string;
  fontMono: string;
  editorLineNumbers: boolean;
  editorSoftWrap: boolean;
  editorTabSize: number;
  defaultPlansRoot: string | null;
  keepAppAlive: boolean;
  planTitleSource: PlanTitleSource;
  hyphenation: boolean;
  bodyLigatures: boolean;
  monoLigatures: boolean;
  showChangeIndicators: boolean;
  compareAgainst: "head";
  showLineBlame: boolean;
  outlineShowTasks: boolean;
  outlineShowNumberedLists: boolean;
  outlineShowBulletedLists: boolean;
  defaultReaderMode: DefaultReaderMode;
  splitScrollSync: boolean;
  showCommitGraph: boolean;
  gitBranchPrefix: string;
  gitPullStrategy: GitPullStrategy;
  gitFetchIntervalSecs: number;
  gitAllowDirectPushToMain: boolean;
  gitConfirmDirectPushToMain: boolean;
  gitShowStatusCluster: boolean;
  docsShowArchivedByDefault: boolean;
  appIcon: string | null;
  terminalAnnounceOutput: boolean;
  defaultTrustPolicy: DefaultTrustPolicy;
  checkForUpdatesOnLaunch: boolean;
  updateChannel: UpdateChannel;
}

export const DEFAULTS: ResolvedSettings = {
  theme: "system",
  themeLightId: "paper",
  themeDarkId: "ink",
  accent: null,
  bodySize: 16,
  uiSize: 13,
  monoSize: 13,
  lineHeight: 1.65,
  density: "comfortable",
  fontSerif: "Source Serif 4",
  fontSans: "IBM Plex Sans",
  fontMono: "JetBrains Mono",
  editorLineNumbers: true,
  editorSoftWrap: true,
  editorTabSize: 2,
  defaultPlansRoot: null,
  keepAppAlive: true,
  planTitleSource: "heading",
  hyphenation: true,
  bodyLigatures: true,
  monoLigatures: false,
  showChangeIndicators: true,
  compareAgainst: "head",
  showLineBlame: false,
  outlineShowTasks: true,
  outlineShowNumberedLists: true,
  outlineShowBulletedLists: false,
  defaultReaderMode: "read",
  splitScrollSync: false,
  showCommitGraph: true,
  gitBranchPrefix: "",
  gitPullStrategy: "ff-only",
  gitFetchIntervalSecs: 300,
  gitAllowDirectPushToMain: true,
  gitConfirmDirectPushToMain: true,
  gitShowStatusCluster: true,
  docsShowArchivedByDefault: false,
  appIcon: null,
  terminalAnnounceOutput: false,
  defaultTrustPolicy: "alwaysAsk",
  checkForUpdatesOnLaunch: true,
  updateChannel: "stable",
};

export const EMPTY_SETTINGS: AppSettings = {
  theme: null,
  themeLightId: null,
  themeDarkId: null,
  accent: null,
  bodySize: null,
  uiSize: null,
  monoSize: null,
  lineHeight: null,
  density: null,
  fontSerif: null,
  fontSans: null,
  fontMono: null,
  editorLineNumbers: null,
  editorSoftWrap: null,
  editorTabSize: null,
  defaultPlansRoot: null,
  keepAppAlive: null,
  planTitleSource: null,
  hyphenation: null,
  bodyLigatures: null,
  monoLigatures: null,
  showChangeIndicators: null,
  compareAgainst: null,
  showLineBlame: null,
  outlineShowTasks: null,
  outlineShowNumberedLists: null,
  outlineShowBulletedLists: null,
  defaultReaderMode: null,
  splitScrollSync: null,
  showCommitGraph: null,
  gitBranchPrefix: null,
  gitPullStrategy: null,
  gitFetchIntervalSecs: null,
  gitAllowDirectPushToMain: null,
  gitConfirmDirectPushToMain: null,
  gitShowStatusCluster: null,
  docsShowArchivedByDefault: null,
  appIcon: null,
  terminalAnnounceOutput: null,
  defaultTrustPolicy: null,
  checkForUpdatesOnLaunch: null,
  updateChannel: null,
};

export function resolve(raw: AppSettings): ResolvedSettings {
  return {
    theme: raw.theme ?? DEFAULTS.theme,
    themeLightId: raw.themeLightId ?? DEFAULTS.themeLightId,
    themeDarkId: raw.themeDarkId ?? DEFAULTS.themeDarkId,
    accent: raw.accent ?? DEFAULTS.accent,
    bodySize: raw.bodySize ?? DEFAULTS.bodySize,
    uiSize: raw.uiSize ?? DEFAULTS.uiSize,
    monoSize: raw.monoSize ?? DEFAULTS.monoSize,
    lineHeight: raw.lineHeight ?? DEFAULTS.lineHeight,
    density: raw.density ?? DEFAULTS.density,
    fontSerif: raw.fontSerif ?? DEFAULTS.fontSerif,
    fontSans: raw.fontSans ?? DEFAULTS.fontSans,
    fontMono: raw.fontMono ?? DEFAULTS.fontMono,
    editorLineNumbers: raw.editorLineNumbers ?? DEFAULTS.editorLineNumbers,
    editorSoftWrap: raw.editorSoftWrap ?? DEFAULTS.editorSoftWrap,
    editorTabSize: raw.editorTabSize ?? DEFAULTS.editorTabSize,
    defaultPlansRoot: raw.defaultPlansRoot ?? DEFAULTS.defaultPlansRoot,
    keepAppAlive: raw.keepAppAlive ?? DEFAULTS.keepAppAlive,
    planTitleSource: raw.planTitleSource ?? DEFAULTS.planTitleSource,
    hyphenation: raw.hyphenation ?? DEFAULTS.hyphenation,
    bodyLigatures: raw.bodyLigatures ?? DEFAULTS.bodyLigatures,
    monoLigatures: raw.monoLigatures ?? DEFAULTS.monoLigatures,
    showChangeIndicators:
      raw.showChangeIndicators ?? DEFAULTS.showChangeIndicators,
    compareAgainst: raw.compareAgainst ?? DEFAULTS.compareAgainst,
    showLineBlame: raw.showLineBlame ?? DEFAULTS.showLineBlame,
    outlineShowTasks: raw.outlineShowTasks ?? DEFAULTS.outlineShowTasks,
    outlineShowNumberedLists:
      raw.outlineShowNumberedLists ?? DEFAULTS.outlineShowNumberedLists,
    outlineShowBulletedLists:
      raw.outlineShowBulletedLists ?? DEFAULTS.outlineShowBulletedLists,
    defaultReaderMode: raw.defaultReaderMode ?? DEFAULTS.defaultReaderMode,
    splitScrollSync: raw.splitScrollSync ?? DEFAULTS.splitScrollSync,
    showCommitGraph: raw.showCommitGraph ?? DEFAULTS.showCommitGraph,
    gitBranchPrefix: raw.gitBranchPrefix ?? DEFAULTS.gitBranchPrefix,
    gitPullStrategy: raw.gitPullStrategy ?? DEFAULTS.gitPullStrategy,
    gitFetchIntervalSecs:
      raw.gitFetchIntervalSecs ?? DEFAULTS.gitFetchIntervalSecs,
    gitAllowDirectPushToMain:
      raw.gitAllowDirectPushToMain ?? DEFAULTS.gitAllowDirectPushToMain,
    gitConfirmDirectPushToMain:
      raw.gitConfirmDirectPushToMain ?? DEFAULTS.gitConfirmDirectPushToMain,
    gitShowStatusCluster:
      raw.gitShowStatusCluster ?? DEFAULTS.gitShowStatusCluster,
    docsShowArchivedByDefault:
      raw.docsShowArchivedByDefault ?? DEFAULTS.docsShowArchivedByDefault,
    appIcon: raw.appIcon ?? DEFAULTS.appIcon,
    terminalAnnounceOutput:
      raw.terminalAnnounceOutput ?? DEFAULTS.terminalAnnounceOutput,
    defaultTrustPolicy: raw.defaultTrustPolicy ?? DEFAULTS.defaultTrustPolicy,
    checkForUpdatesOnLaunch:
      raw.checkForUpdatesOnLaunch ?? DEFAULTS.checkForUpdatesOnLaunch,
    updateChannel: raw.updateChannel ?? DEFAULTS.updateChannel,
  };
}
