import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Root } from "mdast";
import type { RefObject } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChangeSet } from "../tauri/api";
import type { Plan } from "../types";
import { Reader, type ReaderMode } from "./Reader";
import { SplitView } from "./SplitView";

const apiMocks = vi.hoisted(() => ({
  exportToFile: vi.fn(),
  openPlanInNewWindow: vi.fn(),
}));

const openerMocks = vi.hoisted(() => ({
  openUrl: vi.fn(),
}));

const toastMocks = vi.hoisted(() => ({
  push: vi.fn(),
}));

const clipboardMocks = vi.hoisted(() => ({
  write: vi.fn(),
  writeText: vi.fn(),
}));

const trustMocks = vi.hoisted(() => ({
  status: "trusted" as "loading" | "ask" | "trusted" | "untrusted",
}));

const settingsMocks = vi.hoisted(() => ({
  effective: { splitScrollSync: false },
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: "reader-test" }),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: openerMocks.openUrl,
}));

vi.mock("../hooks/useToasts", () => ({
  useToasts: () => ({ push: toastMocks.push }),
}));

vi.mock("../security/trust", () => ({
  remoteAllowed: (status: string) => status === "trusted",
  useWorkspaceTrust: () => ({
    status: trustMocks.status,
    resolved: true,
    set: vi.fn(),
  }),
}));

vi.mock("../settings/store", () => ({
  useSettings: () => ({
    effective: settingsMocks.effective,
  }),
}));

vi.mock("../tauri/api", () => ({
  exportToFile: apiMocks.exportToFile,
  openPlanInNewWindow: apiMocks.openPlanInNewWindow,
}));

vi.mock("../markdown/render", () => ({
  MarkdownRender: (props: {
    onLinkClick: (href: string) => void;
    remoteAllowed: boolean;
    toggleTask: (line: number, checked: boolean) => void;
    onToggleSection: (id: string) => void;
  }) => (
    <div
      data-testid="markdown-render"
      data-remote-allowed={String(props.remoteAllowed)}
    >
      <dl className="doc-frontmatter">
        <dt>title</dt>
        <dd>Metadata Title</dd>
        <dt>status</dt>
        <dd>draft</dd>
      </dl>
      <h1 id="intro" data-source-start-line="1">
        Intro
      </h1>
      <p>Rendered plan content</p>
      <button
        type="button"
        onClick={() => props.onLinkClick("https://example.com/plan")}
      >
        External link
      </button>
      <button type="button" onClick={() => props.onLinkClick("./local.md")}>
        Local link
      </button>
      <button type="button" onClick={() => props.toggleTask(4, true)}>
        Toggle task
      </button>
      <button type="button" onClick={() => props.onToggleSection("intro")}>
        Fold intro
      </button>
    </div>
  ),
}));

vi.mock("./MarkdownEditor", () => ({
  MarkdownEditor: () => <textarea aria-label="Mock markdown editor" />,
}));

vi.mock("./ContextMenu", () => ({
  ContextMenu: (props: {
    items: Array<{
      label: string;
      divider?: boolean;
      disabled?: boolean;
      onSelect?: () => void;
      submenu?: Array<{ label: string; onSelect?: () => void }>;
    }>;
    onClose: () => void;
  }) => (
    <div role="menu">
      {props.items.flatMap((item) => {
        if (item.divider) return [];
        if (item.submenu) {
          return item.submenu.map((child) => (
            <button
              key={`${item.label}:${child.label}`}
              type="button"
              role="menuitem"
              onClick={() => {
                child.onSelect?.();
                props.onClose();
              }}
            >
              {child.label}
            </button>
          ));
        }
        return [
          <button
            key={item.label}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            onClick={() => {
              item.onSelect?.();
              props.onClose();
            }}
          >
            {item.label}
          </button>,
        ];
      })}
    </div>
  ),
}));

function plan(): Plan {
  return {
    id: "active/phase-six.md",
    title: "Phase Six",
    path: "active/phase-six.md",
    bucket: "active",
    modifiedAt: "just now",
    modifiedRaw: 0,
    lineCount: 20,
    wordCount: 120,
    readMinutes: 2,
    status: "in-progress",
    owner: "Jake",
    contributors: [],
    progress: { done: 1, total: 3 },
    tags: ["coverage"],
    iterationCount: 0,
    gitBranches: [],
    gitCommits: [],
    linkedRepoLinks: [],
    frontmatterIssues: [],
  };
}

function emptyChangeSet(): ChangeSet {
  return { added: [], modified: [], deletedAfter: [], hunks: [] };
}

function renderReader(
  props: Partial<Parameters<typeof Reader>[0]> & {
    mode?: ReaderMode;
  } = {},
) {
  const defaults = {
    plan: plan(),
    ast: { type: "root", children: [] } as Root,
    setActiveHeading: vi.fn(),
    toggleTask: vi.fn(),
    onMoveTaskBlock: vi.fn(),
    onInsertTaskAfter: vi.fn(),
    onRemoveTaskBlock: vi.fn(),
    onLinkClick: vi.fn(),
    mode: "read" as ReaderMode,
    setMode: vi.fn(),
    rawMd: "# Phase Six\n\nRendered plan content",
    setRawMd: vi.fn(),
    canGoBack: true,
    canGoForward: false,
    onGoBack: vi.fn(),
    onGoForward: vi.fn(),
    findOpen: false,
    onCloseFind: vi.fn(),
    diff: emptyChangeSet(),
    blame: { lines: [], commits: {} },
    blameEnabled: false,
    onBlameShaClick: vi.fn(),
    collapsed: new Set<string>(),
    onToggleSection: vi.fn(),
    taskCollapsed: new Set<number>(),
    onToggleTaskCollapse: vi.fn(),
    plans: [],
  } satisfies Parameters<typeof Reader>[0];

  return {
    ...render(<Reader {...defaults} {...props} />),
    props: { ...defaults, ...props },
  };
}

describe("Reader", () => {
  beforeEach(() => {
    localStorage.clear();
    trustMocks.status = "trusted";
    apiMocks.exportToFile.mockReset();
    apiMocks.exportToFile.mockResolvedValue("/tmp/phase-six.md");
    apiMocks.openPlanInNewWindow.mockReset();
    apiMocks.openPlanInNewWindow.mockResolvedValue(undefined);
    openerMocks.openUrl.mockReset();
    openerMocks.openUrl.mockResolvedValue(undefined);
    toastMocks.push.mockReset();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: clipboardMocks,
    });
    clipboardMocks.write.mockReset();
    clipboardMocks.write.mockResolvedValue(undefined);
    clipboardMocks.writeText.mockReset();
    clipboardMocks.writeText.mockResolvedValue(undefined);
    Object.defineProperty(globalThis, "ClipboardItem", {
      configurable: true,
      value: undefined,
    });
  });

  it("wires navigation, mode changes, document callbacks, and find handoff", async () => {
    const user = userEvent.setup();
    const toggleTask = vi.fn();
    const onToggleSection = vi.fn();
    const setMode = vi.fn();
    const onGoBack = vi.fn();
    const onGoForward = vi.fn();

    renderReader({
      toggleTask,
      onToggleSection,
      setMode,
      onGoBack,
      onGoForward,
      findOpen: true,
      findInitialQuery: "Rendered",
    });

    await user.click(screen.getByRole("button", { name: "Go back" }));
    await user.click(screen.getByRole("button", { name: "Go forward" }));
    await user.click(screen.getByRole("button", { name: /Edit/ }));
    await user.click(screen.getByRole("button", { name: /Split/ }));
    await user.click(screen.getByRole("button", { name: "Toggle task" }));
    await user.click(screen.getByRole("button", { name: "Fold intro" }));

    expect(onGoBack).toHaveBeenCalledTimes(1);
    expect(onGoForward).not.toHaveBeenCalled();
    expect(setMode).toHaveBeenCalledWith("edit");
    expect(setMode).toHaveBeenCalledWith("split");
    expect(toggleTask).toHaveBeenCalledWith(4, true);
    expect(onToggleSection).toHaveBeenCalledWith("intro");
    expect(
      (screen.getByLabelText("Find in document") as HTMLInputElement).value,
    ).toBe("Rendered");
  });

  it("exposes the full file path on the truncated header path", () => {
    const { container } = renderReader();

    expect(container.querySelector(".rh-path")?.getAttribute("title")).toBe(
      "active/phase-six.md",
    );
  });

  it("surfaces frontmatter issues as structured edit-mode status", () => {
    renderReader({
      mode: "split",
      plan: {
        ...plan(),
        frontmatterIssues: [
          {
            field: "links[1].repo",
            message: "links[1].repo is required.",
          },
          {
            field: "links[1].branch",
            message: "links[1].branch is required.",
          },
        ],
      },
    });

    const status = screen.getByRole("status", {
      name: /Frontmatter issue: links\[1\]\.repo is required\. 1 more\./,
    });

    expect(status.textContent).toContain("Frontmatter");
    expect(screen.getByText("links[1].repo")).toBeTruthy();
    expect(screen.getByText("is required.")).toBeTruthy();
    expect(screen.getByText("+1")).toBeTruthy();
    expect(status.getAttribute("title")).toContain(
      "links[1].branch: links[1].branch is required.",
    );
  });

  it("warns once before opening external links from untrusted workspaces", async () => {
    const user = userEvent.setup();
    trustMocks.status = "untrusted";
    const onLinkClick = vi.fn();

    renderReader({ onLinkClick });

    expect(
      screen.getByTestId("markdown-render").getAttribute("data-remote-allowed"),
    ).toBe("false");

    await user.click(screen.getByRole("button", { name: "External link" }));
    expect(toastMocks.push).toHaveBeenCalledWith(
      "This will open example.com in your browser. Click again to confirm.",
      { tone: "warn" },
    );
    expect(onLinkClick).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "External link" }));
    await user.click(screen.getByRole("button", { name: "Local link" }));

    expect(onLinkClick).toHaveBeenCalledWith("https://example.com/plan");
    expect(onLinkClick).toHaveBeenCalledWith("./local.md");
  });

  it("opens document context actions for export, copy, share, and separate windows", async () => {
    const user = userEvent.setup();
    renderReader();

    fireEvent.contextMenu(screen.getByTestId("markdown-render"));
    await user.click(screen.getByRole("menuitem", { name: "Markdown (.md)" }));

    expect(apiMocks.exportToFile).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultPath: "phase-six.md",
        contents: "# Phase Six\n\nRendered plan content",
      }),
    );
    await waitFor(() =>
      expect(toastMocks.push).toHaveBeenCalledWith("Exported phase-six.md", {
        tone: "success",
      }),
    );

    fireEvent.contextMenu(screen.getByTestId("markdown-render"));
    await user.click(screen.getByRole("menuitem", { name: "Email…" }));
    expect(openerMocks.openUrl).toHaveBeenCalledWith(
      expect.stringContaining("mailto:?subject=Phase%20Six"),
    );

    fireEvent.contextMenu(screen.getByTestId("markdown-render"));
    await user.click(
      screen.getByRole("menuitem", { name: "Open in New Window" }),
    );
    expect(apiMocks.openPlanInNewWindow).toHaveBeenCalledWith(
      "active/phase-six.md",
    );
  });

  it("omits rendered frontmatter from plain and rich copies", async () => {
    class TestClipboardItem {
      constructor(readonly items: Record<string, Blob>) {}
    }
    Object.defineProperty(globalThis, "ClipboardItem", {
      configurable: true,
      value: TestClipboardItem,
    });

    renderReader({
      rawMd: "---\ntitle: Metadata Title\nstatus: draft\n---\n# Phase Six\n",
    });
    expect(screen.getByTestId("markdown-render").textContent).toContain(
      "Rendered plan content",
    );

    fireEvent.contextMenu(screen.getByTestId("markdown-render"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Plain Text" }));
    const plainText = clipboardMocks.writeText.mock.calls.at(-1)?.[0] ?? "";
    expect(plainText).toContain("Rendered plan content");
    expect(plainText).not.toContain("Metadata Title");
    expect(plainText).not.toContain("draft");

    fireEvent.contextMenu(screen.getByTestId("markdown-render"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rich Text" }));
    const richItems = clipboardMocks.write.mock.calls.at(-1)?.[0] as
      | TestClipboardItem[]
      | undefined;
    expect(richItems).toBeTruthy();
    const richText = await richItems?.[0]?.items["text/plain"].text();
    const richHtml = await richItems?.[0]?.items["text/html"].text();

    expect(richText).toContain("Rendered plan content");
    expect(richText).not.toContain("Metadata Title");
    expect(richText).not.toContain("draft");
    expect(richHtml).not.toContain("doc-frontmatter");
    expect(richHtml).not.toContain("Metadata Title");

    fireEvent.contextMenu(screen.getByTestId("markdown-render"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Markdown" }));
    const markdown = clipboardMocks.writeText.mock.calls.at(-1)?.[0] ?? "";
    expect(markdown).toContain("title: Metadata Title");
    expect(markdown).toContain("status: draft");
  });
});

describe("SplitView", () => {
  beforeEach(() => {
    localStorage.clear();
    settingsMocks.effective = { splitScrollSync: false };
  });

  function renderSplit(mode: ReaderMode) {
    const previewScrollRef = {
      current: document.createElement("div"),
    } satisfies RefObject<HTMLDivElement | null>;
    const editorHandleRef = {
      current: {
        focus: vi.fn(),
        currentLine: vi.fn(() => 1),
        onViewportChange: vi.fn(() => vi.fn()),
        revealLine: vi.fn(),
        scrollToFractionalLine: vi.fn(),
        scrollToLine: vi.fn(),
        topVisibleLine: vi.fn(() => 1),
        totalLines: vi.fn(() => 100),
        topLineAtMaxScroll: vi.fn(() => 80),
      },
    };

    const result = render(
      <SplitView
        mode={mode}
        editor={<div>Editor surface</div>}
        preview={<div>Preview surface</div>}
        previewScrollRef={previewScrollRef}
        editorHandleRef={editorHandleRef}
      />,
    );

    const root = result.container.querySelector(
      ".reader-content",
    ) as HTMLElement;
    vi.spyOn(root, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 1_000,
      bottom: 600,
      width: 1_000,
      height: 600,
      toJSON: () => ({}),
    });

    return { ...result, editorHandleRef };
  }

  it("renders single-pane read mode without the resize splitter", () => {
    renderSplit("read");

    expect(screen.getByText("Preview surface")).toBeTruthy();
    expect(screen.getByText("Editor surface")).toBeTruthy();
    expect(screen.queryByLabelText("Resize editor / preview")).toBeNull();
  });

  it("persists keyboard splitter changes and focuses the editor in split mode", () => {
    const { editorHandleRef } = renderSplit("split");
    const splitter = screen.getByLabelText("Resize editor / preview");

    expect(splitter.getAttribute("aria-valuenow")).toBe("50");
    fireEvent.keyDown(splitter, { key: "ArrowRight" });
    expect(splitter.getAttribute("aria-valuenow")).toBe("52");
    expect(localStorage.getItem("specrider.splitRatio.v1.reader-test")).toBe(
      "0.52",
    );
    expect(editorHandleRef.current.focus).toHaveBeenCalled();
  });
});
