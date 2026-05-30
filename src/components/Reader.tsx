import { openUrl } from "@tauri-apps/plugin-opener";
import type { Root } from "mdast";
import {
  lazy,
  type RefObject,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useToasts } from "../hooks/useToasts";
import { type FrontmatterLinkTarget, MarkdownRender } from "../markdown/render";
import { FindInDoc } from "../search/FindInDoc";
import { remoteAllowed, useWorkspaceTrust } from "../security/trust";
import {
  type BlameSet,
  type ChangeSet,
  exportToFile,
  openPlanInNewWindow,
} from "../tauri/api";
import type { FrontmatterIssue, Plan } from "../types";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { Icon } from "./icons";
import type { MarkdownEditorHandle } from "./MarkdownEditor";
import { SplitView } from "./SplitView";

const MarkdownEditor = lazy(() =>
  import("./MarkdownEditor").then((mod) => ({ default: mod.MarkdownEditor })),
);

export type ReaderMode = "read" | "edit" | "split";

interface ReaderProps {
  plan: Plan;
  ast: Root;
  setActiveHeading: (id: string) => void;
  toggleTask: (line: number, checked: boolean) => void;
  onMoveTaskBlock: (
    fromStart: number,
    fromEnd: number,
    anchorLine: number,
    position: "before" | "after",
    newIndent: number,
  ) => void;
  onInsertTaskAfter: (startLine: number, endLine: number) => void;
  onRemoveTaskBlock: (startLine: number, endLine: number) => void;
  onLinkClick: (href: string) => void;
  onFrontmatterLinkClick?: (target: FrontmatterLinkTarget) => void;
  mode: ReaderMode;
  setMode: (next: ReaderMode) => void;
  rawMd: string;
  setRawMd: (next: string) => void;
  canGoBack: boolean;
  canGoForward: boolean;
  onGoBack: () => void;
  onGoForward: () => void;
  findOpen: boolean;
  findInitialQuery?: string;
  onCloseFind: () => void;
  diff: ChangeSet;
  blame: BlameSet;
  blameEnabled: boolean;
  onBlameShaClick: (sha: string) => void;
  collapsed: Set<string>;
  onToggleSection: (id: string) => void;
  taskCollapsed: Set<number>;
  onToggleTaskCollapse: (line: number) => void;
  editorRef?: RefObject<MarkdownEditorHandle | null>;
  /** All plans, forwarded into the editor for the `@`-mention popup. */
  plans: Plan[];
  /** True when the active plan has unresolved merge-conflict markers.
   *  Drives the inline editor decoration and disables read-mode rendering. */
  conflicted?: boolean;
}

function readableFrontmatterIssueMessage(issue: FrontmatterIssue): string {
  const barePrefix = `${issue.field} `;
  const quotedPrefix = `\`${issue.field}\` `;

  if (issue.message.startsWith(barePrefix)) {
    return issue.message.slice(barePrefix.length);
  }

  if (issue.message.startsWith(quotedPrefix)) {
    return issue.message.slice(quotedPrefix.length);
  }

  return issue.message;
}

export function Reader({
  plan,
  ast,
  setActiveHeading,
  toggleTask,
  onMoveTaskBlock,
  onInsertTaskAfter,
  onRemoveTaskBlock,
  onLinkClick,
  onFrontmatterLinkClick,
  mode,
  setMode,
  rawMd,
  setRawMd,
  canGoBack,
  canGoForward,
  onGoBack,
  onGoForward,
  findOpen,
  findInitialQuery,
  onCloseFind,
  diff,
  blame,
  blameEnabled,
  onBlameShaClick,
  collapsed,
  onToggleSection,
  taskCollapsed,
  onToggleTaskCollapse,
  editorRef,
  plans,
  conflicted,
}: ReaderProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const documentRef = useRef<HTMLElement | null>(null);
  const headingRefs = useRef<Record<string, HTMLElement | null>>({});
  const { push: pushToast } = useToasts();
  // Workspace-trust state — gates remote (https://) image loads. The
  // hook re-renders the Reader on flip, MarkdownRender's `memo` sees a
  // changed prop and re-decides each <img> on the next pass.
  const trust = useWorkspaceTrust();
  const allowRemote = remoteAllowed(trust.status);
  const firstFrontmatterIssue = plan.frontmatterIssues[0] ?? null;
  const frontmatterIssueTitle = plan.frontmatterIssues
    .map((issue) => `${issue.field}: ${issue.message}`)
    .join("\n");
  const frontmatterIssueCount = plan.frontmatterIssues.length;
  const extraFrontmatterIssueCount = Math.max(0, frontmatterIssueCount - 1);
  const frontmatterIssueDisplayMessage =
    firstFrontmatterIssue == null
      ? ""
      : readableFrontmatterIssueMessage(firstFrontmatterIssue);
  const frontmatterIssueA11yBody =
    firstFrontmatterIssue == null
      ? ""
      : `${firstFrontmatterIssue.field} ${frontmatterIssueDisplayMessage}`;
  const frontmatterIssueA11yLabel =
    firstFrontmatterIssue == null
      ? undefined
      : frontmatterIssueCount === 1
        ? `Frontmatter issue: ${frontmatterIssueA11yBody}`
        : `Frontmatter issue: ${frontmatterIssueA11yBody}${frontmatterIssueA11yBody.endsWith(".") ? "" : "."} ${extraFrontmatterIssueCount} more.`;

  // Per-session set of remote hosts the user has been warned about.
  // Untrusted workspaces show a one-shot toast on the first click of
  // any link to a never-warned host; the second click passes straight
  // through. Not persisted — every new session starts fresh so the
  // user re-confirms after restart.
  const warnedHostsRef = useRef<Set<string>>(new Set());
  const guardedOnLinkClick = useCallback(
    (href: string) => {
      // Internal hrefs (hash, relative .md) bypass the guard — only
      // external schemes leave the app, and only those carry network /
      // OS-handler risk.
      const isExternalScheme =
        /^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith("#");
      if (!isExternalScheme || allowRemote) {
        onLinkClick(href);
        return;
      }
      // Untrusted (or pending) workspace + external URL. First click
      // for this host warns; second click opens.
      let host: string;
      try {
        host = new URL(href).host || href;
      } catch {
        host = href;
      }
      if (warnedHostsRef.current.has(host)) {
        onLinkClick(href);
        return;
      }
      warnedHostsRef.current.add(host);
      pushToast(
        `This will open ${host} in your browser. Click again to confirm.`,
        { tone: "warn" },
      );
    },
    [onLinkClick, allowRemote, pushToast],
  );

  // Reset scroll on plan switch only. Mode toggles into read/split
  // keep the preview scroll position; edit-only mode intentionally
  // unmounts the preview so typing does not commit a hidden tree.
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = 0;
    }
  }, []);

  const previewVisible = mode === "read" || mode === "split";
  const [editorHasOpened, setEditorHasOpened] = useState(
    () => mode === "edit" || mode === "split",
  );

  // Right-click "Copy As ›" menu on the rendered document. Positioned
  // at the click coords; dismisses on Escape / click-outside / select.
  const [copyMenu, setCopyMenu] = useState<{
    left: number;
    top: number;
  } | null>(null);
  const onDocumentContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
    // Task-row right-clicks call stopPropagation in the renderer, so
    // they never reach here — this handler only fires on plain doc
    // background / paragraphs / headings / etc.
    e.preventDefault();
    setCopyMenu({ left: e.clientX, top: e.clientY });
  };
  const closeCopyMenu = () => setCopyMenu(null);

  const writePlain = (text: string) => {
    navigator.clipboard
      .writeText(text)
      .catch((err) => console.error("clipboard.writeText failed:", err));
  };
  // Returns a deep clone of the rendered document with the in-page UI
  // chrome stripped — task-line labels (L1, L2 …), heading-fold
  // chevrons, table sort arrows / resize handles, and any other
  // aria-hidden decoration. The clone is detached so innerText still
  // honors line breaks / list bullets / table layout.
  const cloneStrippedDocument = (
    options: { stripFrontmatter?: boolean } = {},
  ): HTMLElement | null => {
    const live = documentRef.current;
    if (!live) return null;
    const clone = live.cloneNode(true) as HTMLElement;
    const stripSelectors = [
      '[aria-hidden="true"]',
      // Markdown produces no <button> nodes natively, so anything
      // matching is UI chrome — task-row collapse chevrons (▾),
      // task-check toggles, etc. Stripping by tag is more durable
      // than chasing each new control by classname.
      "button",
      ".task-line",
      ".task-chevron",
      ".task-check",
      ".table-expand-btn",
    ];
    if (options.stripFrontmatter) {
      stripSelectors.push(".doc-frontmatter");
    }
    for (const sel of stripSelectors) {
      clone.querySelectorAll(sel).forEach((el) => {
        el.remove();
      });
    }
    return clone;
  };
  // The clone has to be in the DOM tree for `innerText` to compute
  // line breaks (it depends on layout). Mount off-screen, read, unmount.
  const readStrippedText = (clone: HTMLElement): string => {
    const host = document.createElement("div");
    host.style.position = "fixed";
    host.style.left = "-99999px";
    host.style.top = "0";
    host.style.width = "640px";
    host.style.pointerEvents = "none";
    host.appendChild(clone);
    document.body.appendChild(host);
    const innerText = clone.innerText ?? "";
    const text =
      innerText.trim().length > 0 ? innerText : (clone.textContent ?? "");
    document.body.removeChild(host);
    return text;
  };
  const onCopyMarkdown = () => writePlain(rawMd);
  const onCopyPlain = () => {
    const clone = cloneStrippedDocument({ stripFrontmatter: true });
    if (!clone) {
      writePlain(rawMd);
      return;
    }
    writePlain(readStrippedText(clone));
  };
  const onCopyRich = () => {
    const clone = cloneStrippedDocument({ stripFrontmatter: true });
    if (!clone || typeof ClipboardItem === "undefined") {
      writePlain(clone ? readStrippedText(clone) : rawMd);
      return;
    }
    const text = readStrippedText(clone);
    const html = clone.innerHTML;
    navigator.clipboard
      .write([
        new ClipboardItem({
          "text/html": new Blob([html], { type: "text/html" }),
          "text/plain": new Blob([text], { type: "text/plain" }),
        }),
      ])
      .catch((err) => {
        console.error("clipboard.write rich failed:", err);
        writePlain(text);
      });
  };

  const onOpenInNewWindow = () => {
    openPlanInNewWindow(plan.path).catch((err) =>
      console.error("openPlanInNewWindow:", err),
    );
  };

  // Workspace-relative path so pasting into another doc inside the
  // same plans-root produces a valid Markdown link target. The
  // renderer's resolveRelativePath joins it against the source file's
  // directory, matching how `[label](./foo.md)` already works in-doc.
  const onCopyLink = () => writePlain(plan.path);

  const exportName = (ext: string): string => {
    // Strip the `.md` from the source path and re-stem with the
    // requested extension so the save dialog opens with a sensible
    // default name (e.g. `note.md` → `note.html`).
    const base = plan.path.split("/").pop() ?? "document.md";
    const stem = base.replace(/\.[^.]+$/, "");
    return `${stem}.${ext}`;
  };
  const notifyExport = (dest: string | null) => {
    if (!dest) return; // user cancelled
    const name = dest.split(/[/\\]/).pop() ?? dest;
    pushToast(`Exported ${name}`, { tone: "success" });
  };
  const onExportMarkdown = () => {
    exportToFile({
      defaultPath: exportName("md"),
      filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
      contents: rawMd,
    })
      .then(notifyExport)
      .catch((err) => {
        console.error("exportToFile md:", err);
        pushToast("Export failed", { tone: "error" });
      });
  };
  const onExportHtml = () => {
    const clone = cloneStrippedDocument();
    const body = clone ? clone.outerHTML : `<pre>${rawMd}</pre>`;
    // Self-contained HTML so the export opens in any browser without
    // additional CSS. Theme styles intentionally omitted — the
    // exported file is meant for sharing, not for re-rendering with
    // the reader's chrome.
    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${plan.path}</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;max-width:780px;margin:32px auto;padding:0 16px;line-height:1.55;color:#222}pre,code{font-family:ui-monospace,Menlo,Consolas,monospace}pre{background:#f5f5f5;padding:12px;border-radius:6px;overflow:auto}img{max-width:100%}table{border-collapse:collapse}th,td{border:1px solid #ddd;padding:6px 10px}</style>
</head>
<body>
${body}
</body>
</html>
`;
    exportToFile({
      defaultPath: exportName("html"),
      filters: [{ name: "HTML", extensions: ["html", "htm"] }],
      contents: html,
    })
      .then(notifyExport)
      .catch((err) => {
        console.error("exportToFile html:", err);
        pushToast("Export failed", { tone: "error" });
      });
  };
  const onExportText = () => {
    const clone = cloneStrippedDocument();
    const text = clone ? readStrippedText(clone) : rawMd;
    exportToFile({
      defaultPath: exportName("txt"),
      filters: [{ name: "Plain Text", extensions: ["txt"] }],
      contents: text,
    })
      .then(notifyExport)
      .catch((err) => {
        console.error("exportToFile txt:", err);
        pushToast("Export failed", { tone: "error" });
      });
  };

  // Share via the system mail client. `mailto:` is the only share
  // target that works without a native share-sheet bridge — Tauri
  // doesn't expose NSSharingService. Subject defaults to the H1 if
  // we have one (frontmatter title isn't on the Plan type here).
  const onShareEmail = () => {
    const subject = plan.title || plan.path.split("/").pop() || "Document";
    const url = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(rawMd)}`;
    openUrl(url).catch((err) => console.error("openUrl mailto:", err));
  };

  const copyMenuItems: ContextMenuItem[] = [
    { label: "Open in New Window", onSelect: onOpenInNewWindow },
    { divider: true, label: "" },
    {
      label: "Export…",
      submenu: [
        { label: "Markdown (.md)", onSelect: onExportMarkdown },
        { label: "HTML (.html)", onSelect: onExportHtml },
        { label: "Plain Text (.txt)", onSelect: onExportText },
      ],
    },
    {
      label: "Copy As",
      submenu: [
        { label: "Plain Text", onSelect: onCopyPlain },
        { label: "Rich Text", onSelect: onCopyRich },
        { label: "Markdown", onSelect: onCopyMarkdown },
      ],
    },
    {
      label: "Share",
      submenu: [{ label: "Email…", onSelect: onShareEmail }],
    },
    { label: "Copy Path", onSelect: onCopyLink },
  ];

  useEffect(() => {
    if (mode === "edit" || mode === "split") {
      setEditorHasOpened(true);
    }
  }, [mode]);

  // Active-heading tracker — IntersectionObserver flavor.
  //
  // Why not a scroll listener: the previous implementation called
  // `getBoundingClientRect()` on every heading on every animation
  // frame during scroll. For docs with hundreds of headings that's
  // hundreds of forced layouts per frame and the bottleneck behind
  // sluggish scrolling on large plans. IntersectionObserver computes
  // the intersections off the main thread and only fires events when
  // a heading actually crosses the trigger band, so scroll cost is
  // ~constant regardless of doc length.
  //
  // Strategy: a thin trigger band ~15% from the top of the scroll
  // container. When a heading enters that band it joins `visible`;
  // when it leaves, it's dropped. The active heading is whichever
  // visible heading is *earliest in document order* (so when several
  // are simultaneously inside the band, the topmost wins). When the
  // band is empty (e.g. the user is mid-section, no headings on
  // screen near the top), the previous active stays — that's the
  // section the reader is reading.
  useEffect(() => {
    if (!previewVisible) return;
    const root = scrollRef.current;
    const doc = documentRef.current;
    if (!root || !doc) return;
    const headingEls = Array.from(
      doc.querySelectorAll<HTMLElement>(
        "h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]",
      ),
    );
    if (headingEls.length === 0) return;
    const visible = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).id;
          if (entry.isIntersecting) visible.add(id);
          else visible.delete(id);
        }
        if (visible.size === 0) return;
        for (const el of headingEls) {
          if (visible.has(el.id)) {
            setActiveHeading(el.id);
            break;
          }
        }
      },
      {
        root,
        // Trigger band: top ~15% of the scroll container. Tweak the
        // bottom inset (`-85%`) if the active heading feels late or
        // eager relative to the scroll position.
        rootMargin: "0px 0px -85% 0px",
        threshold: 0,
      },
    );
    for (const el of headingEls) observer.observe(el);
    return () => observer.disconnect();
    // Re-observe when the plan changes (heading set is different),
    // when mode flips into a preview-visible mode (DOM was display:none),
    // when the AST re-parses (heading elements may be new instances),
    // and when the collapsed-set changes (collapsed sections unmount
    // their headings, so the observed set shrinks/grows).
  }, [previewVisible, setActiveHeading]);

  return (
    <main className="pane reader" id="document" aria-label="Document">
      <div className="reader-head">
        <div className="rh-nav">
          <button
            type="button"
            className="rh-nav-btn"
            onClick={onGoBack}
            disabled={!canGoBack}
            title="Back (⌘[)"
            aria-label="Go back"
          >
            <Icon.ChevronL />
          </button>
          <button
            type="button"
            className="rh-nav-btn"
            onClick={onGoForward}
            disabled={!canGoForward}
            title="Forward (⌘])"
            aria-label="Go forward"
          >
            <Icon.ChevronR />
          </button>
        </div>
        <span className="rh-path" title={plan.path}>
          {(() => {
            const slash = plan.path.lastIndexOf("/");
            const dir = slash >= 0 ? plan.path.slice(0, slash + 1) : "";
            const name = slash >= 0 ? plan.path.slice(slash + 1) : plan.path;
            return (
              <>
                {dir && <span className="seg">{dir}</span>}
                <span className="seg-end">{name}</span>
              </>
            );
          })()}
        </span>
        <span className="rh-spacer" />
        {plan.status && <span className="rh-status-pill">{plan.status}</span>}
        <span className="rh-readtime">
          {plan.readMinutes} min · {plan.wordCount.toLocaleString()} words
        </span>
        <div className="rh-modes">
          <button
            type="button"
            aria-pressed={mode === "read"}
            aria-label="Read mode"
            className={`rh-mode ${mode === "read" ? "on" : ""}`}
            onClick={() => setMode("read")}
            title="Reader view"
          >
            <Icon.Read /> <span className="rh-mode-label">Read</span>
          </button>
          <button
            type="button"
            aria-pressed={mode === "edit"}
            aria-label="Edit mode"
            className={`rh-mode ${mode === "edit" ? "on" : ""}`}
            onClick={() => setMode("edit")}
            title="Markdown source"
          >
            <Icon.Pencil /> <span className="rh-mode-label">Edit</span>
          </button>
          <button
            type="button"
            aria-pressed={mode === "split"}
            aria-label="Split mode"
            className={`rh-mode ${mode === "split" ? "on" : ""}`}
            onClick={() => setMode("split")}
            title="Split view — editor and preview side by side"
          >
            <Icon.Split /> <span className="rh-mode-label">Split</span>
          </button>
        </div>
      </div>

      {mode !== "read" && firstFrontmatterIssue && (
        <div
          className="reader-frontmatter-issues"
          role="status"
          aria-label={frontmatterIssueA11yLabel}
          title={frontmatterIssueTitle}
        >
          <Icon.Note />
          <span className="reader-frontmatter-issues-label">Frontmatter</span>
          <code className="reader-frontmatter-issues-field">
            {firstFrontmatterIssue.field}
          </code>
          <span className="reader-frontmatter-issues-message">
            {frontmatterIssueDisplayMessage}
          </span>
          {extraFrontmatterIssueCount > 0 && (
            <span className="reader-frontmatter-issues-count">
              +{extraFrontmatterIssueCount}
            </span>
          )}
        </div>
      )}

      <FindInDoc
        open={findOpen && mode === "read"}
        scopeRef={documentRef}
        scrollRef={scrollRef}
        scanKey={`${plan.id}:${rawMd.length}`}
        initialQuery={findInitialQuery}
        onClose={onCloseFind}
      />

      {/* SplitView swaps the grid template based on `mode`. The editor
          is lazy-mounted on first edit/split use, then kept mounted
          across modes; the preview is mounted only when visible so
          edit-only typing skips preview commits entirely. */}
      <SplitView
        mode={mode}
        previewScrollRef={scrollRef}
        editorHandleRef={editorRef}
        editor={
          editorHasOpened ? (
            <div className="reader-edit-host">
              <Suspense fallback={null}>
                <MarkdownEditor
                  ref={editorRef}
                  value={rawMd}
                  onChange={setRawMd}
                  diff={diff}
                  blame={blame}
                  blameEnabled={blameEnabled}
                  onBlameShaClick={onBlameShaClick}
                  plans={plans}
                  conflicted={conflicted}
                />
              </Suspense>
            </div>
          ) : null
        }
        preview={
          previewVisible ? (
            // biome-ignore lint/a11y/noStaticElementInteractions: custom context menu opens from the document surface.
            <div
              className="reader-scroll"
              ref={scrollRef}
              onContextMenu={onDocumentContextMenu}
            >
              <article className={`document mode-${mode}`} ref={documentRef}>
                <MarkdownRender
                  root={ast}
                  headingRefs={headingRefs}
                  toggleTask={toggleTask}
                  onMoveTaskBlock={onMoveTaskBlock}
                  onInsertTaskAfter={onInsertTaskAfter}
                  onRemoveTaskBlock={onRemoveTaskBlock}
                  onLinkClick={guardedOnLinkClick}
                  onFrontmatterLinkClick={onFrontmatterLinkClick}
                  diff={diff}
                  collapsed={collapsed}
                  onToggleSection={onToggleSection}
                  taskCollapsed={taskCollapsed}
                  onToggleTaskCollapse={onToggleTaskCollapse}
                  planPath={plan.path}
                  remoteAllowed={allowRemote}
                />
              </article>
            </div>
          ) : null
        }
      />
      {copyMenu && (
        <ContextMenu
          anchor={copyMenu}
          items={copyMenuItems}
          onClose={closeCopyMenu}
        />
      )}
    </main>
  );
}
