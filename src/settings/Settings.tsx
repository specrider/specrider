import { invoke } from "@tauri-apps/api/core";
import { writeText as writeClipboardText } from "@tauri-apps/plugin-clipboard-manager";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { BootFallback } from "../components/BootFallback";
import {
  checkForUpdate,
  installUpdater,
  releaseNotesUrl,
  supportsUpdater,
  useUpdaterState,
} from "../lib/updater";
import { type DiagnosticsSnapshot, diagnosticsSnapshot } from "../tauri/api";
import { useApplyCss } from "./applyCss";
import { loadGoogleFont } from "./fontLoader";
import { type FontCategory, GOOGLE_FONTS } from "./google-fonts";
import { ICON_VARIANTS } from "./iconVariants";
import { useSettings } from "./store";
import { BUILTIN_THEMES, type Theme } from "./themes";
import type { AppSettings, ResolvedSettings } from "./types";
import { WorkspaceConfigEditor } from "./WorkspaceConfigEditor";

const SECTIONS = [
  { id: "appearance", label: "Appearance" },
  { id: "typography", label: "Typography" },
  { id: "documents", label: "Documents" },
  { id: "editor", label: "Editor & Outline" },
  { id: "git", label: "Git" },
  { id: "workspace", label: "Workspace" },
  { id: "security", label: "Trust & Access" },
  { id: "app", label: "System & Updates" },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];
const ACTIVE_PLANS_ROOT_KEY = "specrider.activePlansRoot.v1";

interface SectionProps {
  s: ResolvedSettings;
  update: <K extends keyof AppSettings>(
    key: K,
    value: AppSettings[K],
  ) => Promise<void>;
  reset: () => Promise<void>;
}

export function Settings() {
  const { effective, update, reset, loaded, customThemes } = useSettings();
  useApplyCss(effective, customThemes);

  const [active, setActive] = useState<SectionId>("appearance");

  // Wire as a mirror window: subscribe to state changes from main and
  // surface them in the System & Updates section. The check-on-launch flag is
  // ignored here because mirrors don't schedule their own check.
  useEffect(() => {
    let teardown: (() => void) | null = null;
    void installUpdater({ checkOnLaunch: false }).then((fn) => {
      teardown = fn;
    });
    return () => {
      if (teardown) teardown();
    };
  }, []);

  if (!loaded) {
    return <BootFallback />;
  }

  const sectionProps: SectionProps = {
    s: effective,
    update,
    reset: () => reset(active),
  };

  const onRailKeyDown = (e: React.KeyboardEvent) => {
    const idx = SECTIONS.findIndex((s) => s.id === active);
    let nextIdx: number | null = null;
    if (e.key === "ArrowDown") nextIdx = (idx + 1) % SECTIONS.length;
    else if (e.key === "ArrowUp")
      nextIdx = (idx - 1 + SECTIONS.length) % SECTIONS.length;
    else if (e.key === "Home") nextIdx = 0;
    else if (e.key === "End") nextIdx = SECTIONS.length - 1;
    if (nextIdx === null) return;
    e.preventDefault();
    setActive(SECTIONS[nextIdx].id);
    // Focus follows selection — pull the new tab into view.
    requestAnimationFrame(() => {
      const tab = document.getElementById(
        `settings-tab-${SECTIONS[nextIdx].id}`,
      );
      tab?.focus();
    });
  };

  const panelId = `settings-panel-${active}`;
  const tabId = `settings-tab-${active}`;

  return (
    <div className="settings-app">
      <h1 className="sr-only">SpecRider Settings</h1>
      <div className="settings-titlebar" data-tauri-drag-region>
        <div
          className="tb-traffic-spacer"
          data-tauri-drag-region
          aria-hidden="true"
        />
        <span className="settings-title" data-tauri-drag-region>
          Settings
        </span>
      </div>
      <div className="settings-body">
        <nav
          className="settings-rail"
          aria-label="Settings sections"
          onKeyDown={onRailKeyDown}
        >
          {SECTIONS.map((sec) => (
            <button
              key={sec.id}
              id={`settings-tab-${sec.id}`}
              type="button"
              role="tab"
              aria-selected={active === sec.id}
              aria-controls={`settings-panel-${sec.id}`}
              tabIndex={active === sec.id ? 0 : -1}
              className={`settings-tab ${active === sec.id ? "on" : ""}`}
              onClick={() => setActive(sec.id)}
            >
              {sec.label}
            </button>
          ))}
        </nav>
        <main
          className="settings-pane"
          role="tabpanel"
          id={panelId}
          aria-labelledby={tabId}
        >
          {active === "appearance" && <AppearanceSection {...sectionProps} />}
          {active === "typography" && <TypographySection {...sectionProps} />}
          {active === "documents" && <DocumentsSection {...sectionProps} />}
          {active === "editor" && <EditorSection {...sectionProps} />}
          {active === "git" && <GitSection {...sectionProps} />}
          {active === "workspace" && <WorkspaceSection />}
          {active === "security" && <TrustAccessSection {...sectionProps} />}
          {active === "app" && <SystemUpdatesSection {...sectionProps} />}
        </main>
      </div>
    </div>
  );
}

// ─── Sections ────────────────────────────────────────────────────────

function AppearanceSection({ s, update, reset }: SectionProps) {
  const { themes, customThemes } = useSettings();
  const isSystem = s.theme === "system";
  const lightBuiltin = BUILTIN_THEMES.filter((t) => t.type === "light");
  const darkBuiltin = BUILTIN_THEMES.filter((t) => t.type === "dark");
  const lightCustom = customThemes.filter((t) => t.type === "light");
  const darkCustom = customThemes.filter((t) => t.type === "dark");

  // Picking a theme card updates the corresponding pair slot
  // (themeLightId or themeDarkId). When match-system is on, that's the
  // only write — `theme` stays "system" so the OS-level swap keeps
  // working. When match-system is off, we also pin `theme` to the
  // picked id so it applies immediately.
  const applyTheme = (id: string) => {
    const t = themes.find((x) => x.id === id);
    if (!t) return;
    if (t.type === "light") void update("themeLightId", id);
    else void update("themeDarkId", id);
    if (!isSystem) void update("theme", id);
  };

  // Highlighting: in match-system mode, both pair picks light up. In
  // single-theme mode, only the explicit theme lights up.
  const highlightLight = isSystem ? s.themeLightId : s.theme;
  const highlightDark = isSystem ? s.themeDarkId : s.theme;

  // Icon swap is two-step: persist the choice via `set_setting`
  // (so it survives quits and is reapplied on next launch) AND fire
  // `set_app_icon` to perform the live NSWorkspace + NSApp swap. We
  // can't fold both into the store's update() because the side
  // effect is icon-specific.
  const onPickIcon = async (id: string) => {
    await update("appIcon", id);
    try {
      await invoke("set_app_icon", { variant: id });
    } catch (e) {
      console.error("set_app_icon failed:", e);
    }
  };
  const currentIcon = s.appIcon ?? ICON_VARIANTS[0]?.id ?? "default";

  return (
    <Section title="Appearance" onReset={reset}>
      <Field
        inline
        label="Match system theme"
        hint="When on, your Light and Dark picks below auto-swap with macOS Light/Dark mode. Turn off to use a single theme regardless of system appearance."
      >
        <Toggle
          value={isSystem}
          onChange={(on) => {
            if (on) {
              void update("theme", "system");
            } else {
              // Pin to whichever variant is currently visible so the
              // screen doesn't flip when the toggle goes off.
              const dark = window.matchMedia(
                "(prefers-color-scheme: dark)",
              ).matches;
              void update("theme", dark ? s.themeDarkId : s.themeLightId);
            }
          }}
        />
      </Field>
      <Field label="Light theme">
        <ThemePicker
          themes={lightBuiltin}
          value={highlightLight}
          onChange={applyTheme}
        />
        {lightCustom.length > 0 && (
          <div className="settings-custom-themes">
            <div className="settings-custom-label">Custom</div>
            <ThemePicker
              themes={lightCustom}
              value={highlightLight}
              onChange={applyTheme}
            />
          </div>
        )}
      </Field>
      <Field label="Dark theme">
        <ThemePicker
          themes={darkBuiltin}
          value={highlightDark}
          onChange={applyTheme}
        />
        {darkCustom.length > 0 && (
          <div className="settings-custom-themes">
            <div className="settings-custom-label">Custom</div>
            <ThemePicker
              themes={darkCustom}
              value={highlightDark}
              onChange={applyTheme}
            />
          </div>
        )}
      </Field>
      <div className="settings-custom-hint">
        Drop a JSON theme file into your app config dir's <code>themes/</code>{" "}
        subfolder — on macOS that's{" "}
        <code>~/Library/Application Support/dev.specrider.app/themes/</code>.
        Themes appear here within a second. See{" "}
        <code>docs/guides/theming.md</code> for the variable reference.
      </div>
      <Field
        label="Accent color"
        hint="Customize the accent used throughout the app. Use the picker, or type any CSS color (oklch, hex, rgb). Overrides the theme's accent."
      >
        <ColorPicker
          value={s.accent}
          onChange={(v) => update("accent", v)}
          onClear={() => update("accent", null)}
        />
      </Field>
      <Field
        label="Density"
        hint="Affects vertical spacing in the reader, not the type size."
      >
        <Radio
          value={s.density}
          onChange={(v) => update("density", v)}
          options={[
            { value: "comfortable", label: "Comfortable" },
            { value: "dense", label: "Dense" },
          ]}
        />
      </Field>
      <Field
        label="App icon"
        hint="Pick the icon shown in the dock and Finder."
      >
        <Radio
          value={currentIcon}
          onChange={onPickIcon}
          options={ICON_VARIANTS.map((v) => ({ value: v.id, label: v.label }))}
        />
      </Field>
    </Section>
  );
}

function TypographySection({ s, update, reset }: SectionProps) {
  return (
    <Section title="Typography" onReset={reset}>
      <Field
        label="Reader font"
        hint="Used in the reader pane. Pick any family — serif or sans."
      >
        <FontPicker
          defaultCategory="serif"
          value={s.fontSerif}
          onChange={(v) => update("fontSerif", v)}
        />
      </Field>
      <Field
        label="UI font"
        hint="Title bar, plans browser, outline, controls. Pick any family — serif or sans."
      >
        <FontPicker
          defaultCategory="sans"
          value={s.fontSans}
          onChange={(v) => update("fontSans", v)}
        />
      </Field>
      <Field
        label="Code/terminal font"
        hint="Code blocks, line numbers, frontmatter, status bar, agent terminal."
      >
        <FontPicker
          defaultCategory="mono"
          value={s.fontMono}
          onChange={(v) => update("fontMono", v)}
        />
      </Field>
      <Field label={`Reader font size — ${s.bodySize}px`}>
        <Slider
          min={10}
          max={22}
          step={1}
          value={s.bodySize}
          valueText={`${s.bodySize} pixels`}
          onChange={(v) => update("bodySize", v)}
        />
      </Field>
      <Field label={`UI font size — ${s.uiSize}px`}>
        <Slider
          min={10}
          max={22}
          step={1}
          value={s.uiSize}
          valueText={`${s.uiSize} pixels`}
          onChange={(v) => update("uiSize", v)}
        />
      </Field>
      <Field label={`Code/terminal font size — ${s.monoSize}px`}>
        <Slider
          min={10}
          max={22}
          step={1}
          value={s.monoSize}
          valueText={`${s.monoSize} pixels`}
          onChange={(v) => update("monoSize", v)}
        />
      </Field>
      <Field label={`Line height — ${s.lineHeight.toFixed(2)}`}>
        <Slider
          min={1.4}
          max={1.9}
          step={0.05}
          value={s.lineHeight}
          valueText={s.lineHeight.toFixed(2)}
          onChange={(v) => update("lineHeight", v)}
        />
      </Field>
      <Field
        inline
        label="Hyphenation"
        hint="Auto-hyphenate body prose at line breaks. Headings never hyphenate."
      >
        <Toggle
          value={s.hyphenation}
          onChange={(v) => update("hyphenation", v)}
        />
      </Field>
      <Field
        inline
        label="Body ligatures"
        hint="Standard typographic ligatures (fi, fl, ffi…) in reader prose. Off if you find them distracting."
      >
        <Toggle
          value={s.bodyLigatures}
          onChange={(v) => update("bodyLigatures", v)}
        />
      </Field>
      <Field
        inline
        label="Code ligatures"
        hint="Coding ligatures in monospace blocks (==, =>, !=, etc.). Off by default — turn on for fonts like Fira Code or JetBrains Mono."
      >
        <Toggle
          value={s.monoLigatures}
          onChange={(v) => update("monoLigatures", v)}
        />
      </Field>
    </Section>
  );
}

function EditorSection({ s, update, reset }: SectionProps) {
  return (
    <Section title="Editor & Outline" onReset={reset}>
      <Field
        inline
        label="Sync scroll between editor and preview"
        hint="In Split mode, scrolling either side moves the other to the matching heading. 200ms grace window prevents ping-pong."
      >
        <Toggle
          value={s.splitScrollSync}
          onChange={(v) => update("splitScrollSync", v)}
        />
      </Field>
      <Field inline label="Line numbers">
        <Toggle
          value={s.editorLineNumbers}
          onChange={(v) => update("editorLineNumbers", v)}
        />
      </Field>
      <Field
        inline
        label="Soft wrap"
        hint="Wrap long lines inside the editor instead of horizontal-scrolling."
      >
        <Toggle
          value={s.editorSoftWrap}
          onChange={(v) => update("editorSoftWrap", v)}
        />
      </Field>
      <Field label={`Tab size — ${s.editorTabSize}`}>
        <Slider
          min={2}
          max={8}
          step={1}
          value={s.editorTabSize}
          valueText={`${s.editorTabSize} spaces`}
          onChange={(v) => update("editorTabSize", v)}
        />
      </Field>
      <Field
        inline
        label="Outline: tasks"
        hint="Show task list items (`- [ ]`) in the outline pane."
      >
        <Toggle
          value={s.outlineShowTasks}
          onChange={(v) => update("outlineShowTasks", v)}
        />
      </Field>
      <Field
        inline
        label="Outline: numbered lists"
        hint="Show ordered-list items (`1.`, `2.`) in the outline pane — useful for procedures and ranked items."
      >
        <Toggle
          value={s.outlineShowNumberedLists}
          onChange={(v) => update("outlineShowNumberedLists", v)}
        />
      </Field>
      <Field
        inline
        label="Outline: bulleted lists"
        hint="Show bulleted list items (`-`, `*`) in the outline pane. Off by default — usually too granular."
      >
        <Toggle
          value={s.outlineShowBulletedLists}
          onChange={(v) => update("outlineShowBulletedLists", v)}
        />
      </Field>
    </Section>
  );
}

function DocumentsSection({ s, update, reset }: SectionProps) {
  return (
    <Section title="Documents" onReset={reset}>
      <Field
        label="Default folder for new windows"
        hint="When you open a new window without picking a folder, this directory is loaded by default."
      >
        <FolderPicker
          value={s.defaultPlansRoot}
          onChange={(v) => update("defaultPlansRoot", v)}
          onClear={() => update("defaultPlansRoot", null)}
        />
      </Field>
      <Field
        label="Document title source"
        hint="What to display in the left pane when a doc has no frontmatter title. Frontmatter title: always wins when present."
      >
        <Radio
          value={s.planTitleSource}
          options={[
            { value: "heading", label: "First H1 heading" },
            { value: "filename", label: "Filename" },
          ]}
          onChange={(v) =>
            update("planTitleSource", v as "heading" | "filename")
          }
        />
      </Field>
      <Field
        label="Default mode"
        hint="What mode new documents open in. Read renders the Markdown; Edit shows the source; Split puts both side by side."
      >
        <Radio
          value={s.defaultReaderMode}
          options={[
            { value: "read", label: "Read" },
            { value: "edit", label: "Edit" },
            { value: "split", label: "Split" },
          ]}
          onChange={(v) =>
            update("defaultReaderMode", v as "read" | "edit" | "split")
          }
        />
      </Field>
    </Section>
  );
}

function GitSection({ s, update, reset }: SectionProps) {
  return (
    <Section title="Git" onReset={reset}>
      <Field
        inline
        label="Show change indicators"
        hint="When the documents folder is in a git repo, paint gutter bars, outline-row gutters, read-mode block stripes, and a status-bar chip for unstaged changes vs HEAD."
      >
        <Toggle
          value={s.showChangeIndicators}
          onChange={(v) => update("showChangeIndicators", v)}
        />
      </Field>
      <Field
        inline
        label="Show per-line blame"
        hint="In the Markdown editor, an end-of-line annotation shows the commit that introduced the line under the cursor. ⌘⇧B toggles for the session. Off by default — git blame is heavier than the diff and visually denser."
      >
        <Toggle
          value={s.showLineBlame}
          onChange={(v) => update("showLineBlame", v)}
        />
      </Field>
      <Field
        inline
        label="Show commit graph lanes"
        hint="In the diff explorer's commit history, draw lane glyphs to the left of each row showing how branches and merges relate. Off → just the metadata columns (denser, more text-focused)."
      >
        <Toggle
          value={s.showCommitGraph}
          onChange={(v) => update("showCommitGraph", v)}
        />
      </Field>
      <Field
        inline
        label="Show git status in status bar"
        hint="The branch chip + ahead/behind/dirty cluster. Off → status bar shows just line count."
      >
        <Toggle
          value={s.gitShowStatusCluster}
          onChange={(v) => update("gitShowStatusCluster", v)}
        />
      </Field>
      <Field
        label="Pull strategy"
        hint="Fast-forward only is safest — refuses to pull when your branch has diverged. Rebase replays your local commits on top of the upstream tip; pick this only if you know what merge conflicts during rebase look like."
      >
        <Radio
          value={s.gitPullStrategy}
          options={[
            { value: "ff-only", label: "Fast-forward only" },
            { value: "rebase", label: "Rebase" },
          ]}
          onChange={(v) => update("gitPullStrategy", v as "ff-only" | "rebase")}
        />
      </Field>
      <Field
        label="New-branch prefix"
        hint="When you create a new branch from the picker, this string pre-fills the name. Leave empty to disable. Useful for projects that namespace spec branches (specs/, plan/, etc.)."
      >
        <TextInput
          placeholder="e.g. specs/"
          value={s.gitBranchPrefix}
          onChange={(v) => void update("gitBranchPrefix", v)}
        />
      </Field>
      <Field
        label="Background fetch interval"
        hint="How often to run `git fetch` in the background to refresh ahead/behind counts. 0 disables. Pause when the window is hidden. Read-only — never writes to your tree."
      >
        <NumberInput
          value={s.gitFetchIntervalSecs}
          min={0}
          step={60}
          suffix="seconds"
          onChange={(n) => void update("gitFetchIntervalSecs", n)}
        />
      </Field>
      <Field
        inline
        label="Allow direct push to main"
        hint="When on, SpecRider lets Git and the remote decide whether pushes to main, master, or trunk are allowed. Turn this off for a local hard block in the UI."
      >
        <Toggle
          value={s.gitAllowDirectPushToMain}
          onChange={(v) => update("gitAllowDirectPushToMain", v)}
        />
      </Field>
      <Field
        inline
        label="Confirm direct push to main"
        hint="When direct pushes are allowed, ask before pushing to main, master, or trunk from the UI."
      >
        <Toggle
          value={s.gitConfirmDirectPushToMain}
          onChange={(v) => update("gitConfirmDirectPushToMain", v)}
        />
      </Field>
    </Section>
  );
}

function WorkspaceSection() {
  const [plansRoot, setPlansRoot] = useState<string | null>(() =>
    readActivePlansRoot(),
  );

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === ACTIVE_PLANS_ROOT_KEY) {
        setPlansRoot(event.newValue);
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  return (
    <Section title="Workspace">
      <Field
        label="Workspace config"
        hint="Edit .specrider/workspace.json for workspace statuses and linked repository handles."
      >
        <WorkspaceConfigField plansRoot={plansRoot} />
      </Field>
    </Section>
  );
}

function WorkspaceConfigField({ plansRoot }: { plansRoot: string | null }) {
  const { controlId } = useFieldIds();
  return <WorkspaceConfigEditor plansRoot={plansRoot} editorId={controlId} />;
}

function readActivePlansRoot(): string | null {
  try {
    const root = localStorage.getItem(ACTIVE_PLANS_ROOT_KEY);
    return root?.trim() ? root : null;
  } catch {
    return null;
  }
}

function TextInput({
  value,
  placeholder,
  onChange,
}: {
  value: string;
  placeholder?: string;
  onChange: (v: string) => void;
}) {
  const { controlId } = useFieldIds();
  return (
    <input
      type="text"
      id={controlId}
      className="ctl-text"
      placeholder={placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function NumberInput({
  value,
  min,
  step,
  suffix,
  onChange,
}: {
  value: number;
  min?: number;
  step?: number;
  suffix?: string;
  onChange: (v: number) => void;
}) {
  const { controlId } = useFieldIds();
  return (
    <span className="ctl-number">
      <input
        type="number"
        id={controlId}
        className="ctl-number-input"
        value={value}
        min={min}
        step={step ?? 1}
        onChange={(e) => {
          const n = Number.parseInt(e.target.value, 10);
          if (Number.isFinite(n)) onChange(n);
        }}
      />
      {suffix && <span className="ctl-number-suffix">{suffix}</span>}
    </span>
  );
}

function TrustAccessSection({ s, update, reset }: SectionProps) {
  return (
    <Section title="Trust & Access" onReset={reset}>
      <Field
        label="Default for new workspaces"
        hint="What to do the first time a previously-unseen plans folder opens. Always ask is the safest — every new folder prompts. Always trust skips the prompt for power users with many local repos. Always block silently treats every new folder as untrusted; you can flip individual folders later from the title-bar shield."
      >
        <Radio
          value={s.defaultTrustPolicy}
          options={[
            { value: "alwaysAsk", label: "Always ask" },
            { value: "alwaysTrust", label: "Always trust" },
            { value: "alwaysUntrust", label: "Always block" },
          ]}
          onChange={(v) =>
            update(
              "defaultTrustPolicy",
              v as "alwaysAsk" | "alwaysTrust" | "alwaysUntrust",
            )
          }
        />
      </Field>
      <Field
        inline
        label="Announce terminal output"
        hint="Mirror agent-terminal output into a hidden textarea so screen readers can read it. Off by default — the mirror is heavy under flood (e.g. find /)."
      >
        <Toggle
          value={s.terminalAnnounceOutput}
          onChange={(v) => update("terminalAnnounceOutput", v)}
        />
      </Field>
    </Section>
  );
}

function SystemUpdatesSection({ s, update, reset }: SectionProps) {
  const updater = useUpdaterState();
  const [checking, setChecking] = useState(false);
  const [lastCheckedLabel, setLastCheckedLabel] = useState<string>("");
  const [snap, setSnap] = useState<DiagnosticsSnapshot | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  const availableUpdate =
    updater.status === "available" ? updater.update : null;

  // Refresh the relative-time label whenever the state's lastCheckedAt
  // changes — also tick once a minute so "2 minutes ago" stays current
  // without an external timer.
  useEffect(() => {
    const renderLabel = () => {
      if (updater.lastCheckedAt === null) {
        setLastCheckedLabel("Never checked this session");
        return;
      }
      const seconds = Math.max(
        0,
        Math.round((Date.now() - updater.lastCheckedAt) / 1000),
      );
      if (seconds < 10) setLastCheckedLabel("Just now");
      else if (seconds < 60) setLastCheckedLabel(`${seconds}s ago`);
      else if (seconds < 3600)
        setLastCheckedLabel(`${Math.round(seconds / 60)}m ago`);
      else setLastCheckedLabel(`${Math.round(seconds / 3600)}h ago`);
    };
    renderLabel();
    const t = window.setInterval(renderLabel, 60_000);
    return () => window.clearInterval(t);
  }, [updater.lastCheckedAt]);

  useEffect(() => {
    let cancelled = false;
    diagnosticsSnapshot()
      .then((s) => {
        if (!cancelled) setSnap(s);
      })
      .catch((e) => {
        if (!cancelled) console.error("diagnosticsSnapshot:", e);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 2s auto-dismiss for the "Copied - paste into your issue" inline
  // confirmation. The Settings window has no ToastProvider; this lives
  // adjacent to the button instead.
  useEffect(() => {
    if (copyState === "idle") return;
    const t = window.setTimeout(() => setCopyState("idle"), 2000);
    return () => window.clearTimeout(t);
  }, [copyState]);

  const supported = supportsUpdater(updater.installKind);

  const onCheckNow = async () => {
    setChecking(true);
    try {
      // checkForUpdate from a mirror window forwards via Tauri event;
      // the actual check runs in the main window. We don't await the
      // result here — main broadcasts state changes via the same
      // event stream we already subscribe to.
      await checkForUpdate({ silent: false });
    } catch (e) {
      console.error("[updater] manual check failed:", e);
    } finally {
      // Brief pause so the spinner feedback is perceptible even when
      // the response comes back instantly.
      window.setTimeout(() => setChecking(false), 400);
    }
  };

  const openReleasesPage = () => {
    openUrl("https://github.com/specrider/specrider/releases").catch((e) =>
      console.error("[updater] openUrl releases:", e),
    );
  };

  const onCopy = async () => {
    try {
      // Re-fetch so the snapshot reflects the current trust state /
      // plans-root even if the user changed it after opening Settings.
      const fresh = await diagnosticsSnapshot();
      setSnap(fresh);
      await writeClipboardText(fresh.markdown);
      setCopyState("copied");
    } catch (e) {
      console.error("copy diagnostics:", e);
      setCopyState("failed");
    }
  };

  let unsupportedBody: string | null = null;
  if (!supported) {
    if (updater.installKind === "windows") {
      unsupportedBody =
        "Windows updates are manual for now. Re-download the latest installer from the GitHub Releases page when a new version ships.";
    } else if (updater.installKind === "linux-deb-or-rpm") {
      unsupportedBody =
        "This binary was installed via your distro's package manager (deb/rpm). Updates land through `apt`/`dnf`/`pacman` — not through SpecRider.";
    } else {
      unsupportedBody =
        "Auto-updates aren't supported on this platform. Download new releases manually from GitHub.";
    }
  }

  return (
    <Section title="System & Updates" onReset={reset}>
      <Field
        inline
        label="Keep app alive when last window closes"
        hint="macOS-style: closing the last window leaves the app running so you can reopen quickly."
      >
        <Toggle
          value={s.keepAppAlive}
          onChange={(v) => update("keepAppAlive", v)}
        />
      </Field>
      {supported ? (
        <>
          <Field
            inline
            label="Check for updates on launch"
            hint="Silent background check ~30 seconds after the main window opens. Off → updates only happen when you click Check Now."
          >
            <Toggle
              value={s.checkForUpdatesOnLaunch}
              onChange={(v) => update("checkForUpdatesOnLaunch", v)}
            />
          </Field>
          <Field label="Channel">
            <Radio
              value={s.updateChannel}
              options={[
                { value: "stable", label: "Stable" },
                { value: "pre", label: "Pre-release" },
              ]}
              onChange={(v) => update("updateChannel", v as "stable" | "pre")}
            />
          </Field>
          <Field label="Check now" hint={lastCheckedLabel}>
            <button
              type="button"
              className="settings-action"
              onClick={() => void onCheckNow()}
              disabled={checking || updater.status === "checking"}
            >
              {checking || updater.status === "checking"
                ? "Checking…"
                : "Check now"}
            </button>
          </Field>
          <Field label="Status">
            <span className="settings-static">
              {renderUpdaterStatusLabel(updater)}
            </span>
          </Field>
          {availableUpdate && (
            <Field label="Release notes">
              <button
                type="button"
                className="settings-action"
                onClick={() =>
                  openUrl(releaseNotesUrl(availableUpdate.version)).catch((e) =>
                    console.error("[updater] open notes:", e),
                  )
                }
              >
                View v{availableUpdate.version} notes ↗
              </button>
            </Field>
          )}
        </>
      ) : (
        <Field label="Updates" hint={unsupportedBody ?? undefined}>
          <button
            type="button"
            className="settings-action"
            onClick={openReleasesPage}
          >
            Open Releases on GitHub ↗
          </button>
        </Field>
      )}
      <Field label="Version">
        <span className="settings-static">
          {snap ? `${snap.appVersion} (Tauri ${snap.tauriVersion})` : "…"}
        </span>
      </Field>
      <Field label="Bundle id">
        <span className="settings-static">dev.specrider.app</span>
      </Field>
      <Field label="License">
        <span className="settings-static">GPL-3.0-or-later</span>
      </Field>
      <Field label="Diagnostics">
        <div className="ctl-diagnostics">
          <button
            type="button"
            className="settings-action"
            onClick={() => void onCopy()}
          >
            Copy diagnostics
          </button>
          <span
            className="ctl-diagnostics-status"
            role="status"
            aria-live="polite"
          >
            {copyState === "copied"
              ? "Copied — paste into your issue"
              : copyState === "failed"
                ? "Copy failed — see console"
                : ""}
          </span>
        </div>
      </Field>
    </Section>
  );
}

function renderUpdaterStatusLabel(updater: {
  status: string;
  update: { version: string } | null;
  error: string | null;
}): string {
  switch (updater.status) {
    case "idle":
      return "Up to date check pending";
    case "checking":
      return "Checking…";
    case "available":
      return updater.update
        ? `Update available: v${updater.update.version}`
        : "Update available";
    case "downloading":
      return "Downloading update…";
    case "installing":
      return "Installing…";
    case "restart-pending":
      return "Restart to finish updating";
    case "none":
      return "Up to date";
    case "error":
      return updater.error
        ? `Last check failed: ${updater.error}`
        : "Last check failed";
    default:
      return updater.status;
  }
}

// ─── Layout primitives ───────────────────────────────────────────────

function Section({
  title,
  onReset,
  children,
}: {
  title: string;
  /** Omit when the section has no resettable settings. */
  onReset?: () => Promise<void>;
  children: ReactNode;
}) {
  return (
    <div className="settings-section">
      <div className="settings-section-head">
        <h2>{title}</h2>
        {onReset && (
          <button
            type="button"
            className="settings-reset"
            onClick={() => void onReset()}
          >
            Reset section
          </button>
        )}
      </div>
      <div className="settings-fields">{children}</div>
    </div>
  );
}

/** Field-scoped ids so wrapped controls (Toggle, Radio, ThemePicker,
 *  ColorPicker…) can reach the label without each Field call site
 *  having to plumb props. Inputs that *can* take htmlFor pick up
 *  `controlId`; custom-widget controls use `labelId` via
 *  `aria-labelledby`. */
interface FieldIds {
  controlId: string;
  labelId: string;
  hintId: string | null;
}
const FieldContext = createContext<FieldIds | null>(null);
function useFieldIds(): FieldIds {
  const ctx = useContext(FieldContext);
  if (!ctx) {
    throw new Error("control rendered outside a <Field>");
  }
  return ctx;
}

function Field({
  label,
  hint,
  inline,
  children,
}: {
  label: string;
  hint?: string;
  /** When true, label and control share a row (used for toggles).
   *  Hint, if any, drops to a second row underneath. */
  inline?: boolean;
  children: ReactNode;
}) {
  const baseId = useId();
  const ids: FieldIds = {
    controlId: `field-${baseId}-control`,
    labelId: `field-${baseId}-label`,
    hintId: hint ? `field-${baseId}-hint` : null,
  };
  return (
    <FieldContext.Provider value={ids}>
      <div className={`settings-field ${inline ? "inline" : ""}`}>
        <div className="settings-field-row">
          <label
            id={ids.labelId}
            htmlFor={ids.controlId}
            className="settings-field-label"
          >
            {label}
          </label>
          <div className="settings-field-control">{children}</div>
        </div>
        {hint && (
          <div id={ids.hintId ?? undefined} className="settings-field-hint">
            {hint}
          </div>
        )}
      </div>
    </FieldContext.Provider>
  );
}

// ─── Controls ────────────────────────────────────────────────────────

const FONT_CATEGORIES: FontCategory[] = ["serif", "sans", "mono", "display"];
const FONT_CATEGORY_LABELS: Record<FontCategory, string> = {
  serif: "Serif",
  sans: "Sans",
  mono: "Mono",
  display: "Display",
};

function FontPicker({
  defaultCategory,
  value,
  onChange,
}: {
  defaultCategory: FontCategory;
  value: string;
  onChange: (family: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<FontCategory>(defaultCategory);
  const [query, setQuery] = useState("");
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  // Always preview the active selection so the trigger button reflects
  // whatever font the user currently has applied.
  useEffect(() => {
    loadGoogleFont(value);
  }, [value]);

  // Click-outside / Esc to dismiss.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (
        !popoverRef.current?.contains(t) &&
        !triggerRef.current?.contains(t)
      ) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return GOOGLE_FONTS.filter((f) => {
      if (q) return f.family.toLowerCase().includes(q);
      return f.category === category;
    });
  }, [category, query]);

  const { controlId, labelId } = useFieldIds();
  return (
    <div className="ctl-font">
      <button
        type="button"
        id={controlId}
        ref={triggerRef}
        className="ctl-font-trigger"
        aria-labelledby={labelId}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        style={{ fontFamily: `"${value}", ${categoryFallback(category)}` }}
      >
        <span className="ctl-font-trigger-name">{value}</span>
        <span className="ctl-font-trigger-caret">▾</span>
      </button>
      {open && (
        <div className="ctl-font-popover" ref={popoverRef}>
          <div className="ctl-font-search">
            <input
              type="text"
              placeholder="Search fonts…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          {!query && (
            <div className="ctl-font-categories">
              {FONT_CATEGORIES.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`ctl-font-category ${c === category ? "on" : ""}`}
                  onClick={() => setCategory(c)}
                >
                  {FONT_CATEGORY_LABELS[c]}
                </button>
              ))}
            </div>
          )}
          <div className="ctl-font-list">
            {filtered.map((f) => (
              <FontRow
                key={f.family}
                family={f.family}
                active={f.family === value}
                onPick={() => {
                  onChange(f.family);
                  setOpen(false);
                }}
              />
            ))}
            {filtered.length === 0 && (
              <div className="ctl-font-empty">
                No fonts match "{query}". Type the name in the field below if
                it's installed locally.
              </div>
            )}
          </div>
          <div className="ctl-font-custom">
            <input
              type="text"
              placeholder="Or type any family name…"
              defaultValue={value}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  const next = (e.target as HTMLInputElement).value.trim();
                  if (next) {
                    onChange(next);
                    setOpen(false);
                  }
                }
              }}
              onBlur={(e) => {
                const next = e.target.value.trim();
                if (next && next !== value) onChange(next);
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function FontRow({
  family,
  active,
  onPick,
}: {
  family: string;
  active: boolean;
  onPick: () => void;
}) {
  const ref = useRef<HTMLButtonElement | null>(null);
  // Lazy-load each row's font when it scrolls into view.
  useEffect(() => {
    if (!ref.current) return;
    const el = ref.current;
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            loadGoogleFont(family);
            io.unobserve(el);
            break;
          }
        }
      },
      { root: el.parentElement, rootMargin: "120px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [family]);

  return (
    <button
      type="button"
      ref={ref}
      className={`ctl-font-row ${active ? "on" : ""}`}
      onClick={onPick}
      style={{ fontFamily: `"${family}", system-ui` }}
    >
      {family}
    </button>
  );
}

function categoryFallback(c: FontCategory): string {
  if (c === "serif") return "serif";
  if (c === "mono") return "monospace";
  return "sans-serif";
}

function ThemePicker({
  themes,
  value,
  onChange,
}: {
  themes: Theme[];
  value: string;
  onChange: (id: string) => void;
}) {
  const { labelId } = useFieldIds();
  return (
    <div className="ctl-theme-grid" role="radiogroup" aria-labelledby={labelId}>
      {themes.map((t) => {
        const paper = t.variables["--paper"] ?? "transparent";
        const ink = t.variables["--ink"] ?? "transparent";
        const accent = t.variables["--accent"] ?? "transparent";
        const sage = t.variables["--sage"] ?? "transparent";
        const active = t.id === value;
        return (
          // biome-ignore lint/a11y/useSemanticElements: theme cards use ARIA radio semantics with custom visual cards.
          <button
            key={t.id}
            type="button"
            role="radio"
            aria-checked={active}
            className={`ctl-theme-card ${active ? "on" : ""}`}
            onClick={() => onChange(t.id)}
            title={t.author ? `${t.name} — ${t.author}` : t.name}
          >
            <div className="ctl-theme-swatch" style={{ background: paper }}>
              <span style={{ background: ink }} />
              <span style={{ background: accent }} />
              <span style={{ background: sage }} />
            </div>
            <div className="ctl-theme-name">{t.name}</div>
          </button>
        );
      })}
    </div>
  );
}

function Toggle({
  value,
  onChange,
}: {
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  const { controlId, labelId } = useFieldIds();
  return (
    <button
      type="button"
      id={controlId}
      role="switch"
      aria-checked={value}
      aria-labelledby={labelId}
      className={`ctl-toggle ${value ? "on" : ""}`}
      onClick={() => onChange(!value)}
    >
      <span className="ctl-toggle-thumb" />
    </button>
  );
}

function Slider({
  min,
  max,
  step,
  value,
  onChange,
  valueText,
}: {
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
  /** Optional human-readable rendition for SR (e.g. "16 px", "1.55"). */
  valueText?: string;
}) {
  const { controlId } = useFieldIds();
  return (
    <input
      type="range"
      id={controlId}
      className="ctl-slider"
      min={min}
      max={max}
      step={step}
      value={value}
      aria-valuetext={valueText}
      onChange={(e) => onChange(parseFloat(e.target.value))}
    />
  );
}

function Radio<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  const { labelId } = useFieldIds();
  return (
    <div
      className="ctl-radio-group"
      role="radiogroup"
      aria-labelledby={labelId}
    >
      {options.map((opt) => (
        // biome-ignore lint/a11y/useSemanticElements: segmented controls use ARIA radio semantics with button styling.
        <button
          key={opt.value}
          type="button"
          role="radio"
          aria-checked={opt.value === value}
          className={`ctl-radio ${opt.value === value ? "on" : ""}`}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function ColorPicker({
  value,
  onChange,
  onClear,
}: {
  value: string | null;
  onChange: (v: string) => void;
  onClear: () => void;
}) {
  const { controlId, labelId } = useFieldIds();
  // The native <input type="color"> only emits hex; we keep a separate
  // text input for free-form CSS color strings (oklch, rgb, hsl, etc).
  // Hex from the picker is converted to oklch-compatible form by just
  // passing it through — the browser parses hex everywhere we use the
  // var, so this is fine.
  const display = value ?? "";
  const swatch = displayHex(value);
  return (
    <div className="ctl-color">
      <input
        type="color"
        className="ctl-color-swatch"
        value={swatch}
        aria-labelledby={labelId}
        onChange={(e) => onChange(e.target.value)}
      />
      <input
        type="text"
        id={controlId}
        className="ctl-color-input"
        placeholder="default"
        value={display}
        onChange={(e) => onChange(e.target.value)}
      />
      {value && (
        <button
          type="button"
          className="ctl-color-clear"
          onClick={onClear}
          aria-label="Reset to default"
          title="Reset to default"
        >
          ×
        </button>
      )}
    </div>
  );
}

function FolderPicker({
  value,
  onChange,
  onClear,
}: {
  value: string | null;
  onChange: (v: string) => void;
  onClear: () => void;
}) {
  const { controlId, labelId } = useFieldIds();
  const onPick = async () => {
    try {
      const picked = await openDialog({ directory: true, multiple: false });
      if (typeof picked === "string") onChange(picked);
    } catch (e) {
      console.error("openDialog failed:", e);
    }
  };
  return (
    <div className="ctl-folder">
      <button
        type="button"
        id={controlId}
        className="ctl-folder-btn"
        aria-labelledby={labelId}
        onClick={() => void onPick()}
      >
        Choose folder…
      </button>
      <span className="ctl-folder-path" title={value ?? ""}>
        {value ?? <em>not set</em>}
      </span>
      {value && (
        <button
          type="button"
          className="ctl-folder-clear"
          onClick={onClear}
          aria-label="Clear"
        >
          ×
        </button>
      )}
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────

/** The native color picker only accepts hex. Best-effort fall-back so it
 *  always has something sensible to show even when the underlying value
 *  is `null` or a non-hex CSS color. */
function displayHex(value: string | null): string {
  if (!value) return "#5577dd";
  if (/^#[0-9a-fA-F]{6}$/.test(value)) return value;
  if (/^#[0-9a-fA-F]{3}$/.test(value)) {
    return (
      "#" +
      value
        .slice(1)
        .split("")
        .map((c) => c + c)
        .join("")
    );
  }
  return "#5577dd";
}
