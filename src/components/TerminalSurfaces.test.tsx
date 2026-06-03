import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalPane } from "./TerminalPane";
import { TerminalSpike } from "./TerminalSpike";

const terminalSessionMocks = vi.hoisted(() => {
  const container = { current: null as HTMLDivElement | null };
  const term = {
    clearSelection: vi.fn(),
    focus: vi.fn(),
    getSelection: vi.fn(() => ""),
    paste: vi.fn(),
  };
  return {
    session: {
      containerRef: container,
      status: "idle",
      session: { id: "term-1", cwd: "/Users/jake/Sites/specrider" },
      error: null as string | null,
      exitCode: null as number | null,
      start: vi.fn(),
      attach: vi.fn(),
      kill: vi.fn(),
      fit: vi.fn(),
      term,
      cwd: null as string | null,
    },
    term,
  };
});

const settingsMocks = vi.hoisted(() => ({
  effective: {
    fontMono: "JetBrains Mono",
    monoSize: 13,
    terminalAnnounceOutput: false,
  },
}));

const apiMocks = vi.hoisted(() => ({
  terminalWrite: vi.fn(),
}));

const clipboardMocks = vi.hoisted(() => ({
  readText: vi.fn(),
}));

const xtermMocks = vi.hoisted(() => {
  class MockTerminal {
    static instances: MockTerminal[] = [];
    clear = vi.fn();
    dispose = vi.fn();
    focus = vi.fn();
    loadAddon = vi.fn();
    open = vi.fn();
    write = vi.fn((_payload: string, cb?: () => void) => {
      cb?.();
    });

    constructor() {
      MockTerminal.instances.push(this);
    }
  }

  class MockFitAddon {
    fit = vi.fn();
  }

  class MockWebglAddon {
    onContextLoss = vi.fn();
  }

  return { MockTerminal, MockFitAddon, MockWebglAddon };
});

vi.mock("../hooks/useTerminalSession", () => ({
  useTerminalSession: () => terminalSessionMocks.session,
}));

vi.mock("../settings/store", () => ({
  useSettings: () => ({ effective: settingsMocks.effective }),
}));

vi.mock("../tauri/api", () => ({
  terminalWrite: apiMocks.terminalWrite,
}));

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  readText: clipboardMocks.readText,
}));

vi.mock("@tauri-apps/api/path", () => ({
  homeDir: vi.fn(() => Promise.resolve("/Users/jake")),
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: xtermMocks.MockTerminal,
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: xtermMocks.MockFitAddon,
}));

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: xtermMocks.MockWebglAddon,
}));

describe("TerminalPane", () => {
  beforeEach(() => {
    terminalSessionMocks.session.status = "idle";
    terminalSessionMocks.session.error = null;
    terminalSessionMocks.session.exitCode = null;
    terminalSessionMocks.session.cwd = null;
    terminalSessionMocks.session.session = {
      id: "term-1",
      cwd: "/Users/jake/Sites/specrider",
    };
    terminalSessionMocks.session.start.mockReset();
    terminalSessionMocks.session.start.mockResolvedValue(
      terminalSessionMocks.session.session,
    );
    terminalSessionMocks.session.fit.mockReset();
    terminalSessionMocks.term.clearSelection.mockReset();
    terminalSessionMocks.term.focus.mockReset();
    terminalSessionMocks.term.getSelection.mockReset();
    terminalSessionMocks.term.getSelection.mockReturnValue("");
    terminalSessionMocks.term.paste.mockReset();
    apiMocks.terminalWrite.mockReset();
    apiMocks.terminalWrite.mockResolvedValue(undefined);
    clipboardMocks.readText.mockReset();
    clipboardMocks.readText.mockResolvedValue("pasted text");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  it("lazy-mounts, starts once, displays cwd/status, and closes from the header", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { rerender } = render(
      <TerminalPane
        open={false}
        cwd="/Users/jake/Sites/specrider"
        initialAgent="codex"
        onClose={onClose}
      />,
    );

    expect(screen.queryByLabelText("Agent terminal")).toBeNull();

    rerender(
      <TerminalPane
        open={true}
        cwd="/Users/jake/Sites/specrider"
        initialAgent="codex"
        onClose={onClose}
      />,
    );

    await waitFor(() =>
      expect(terminalSessionMocks.session.start).toHaveBeenCalledWith({
        cwd: "/Users/jake/Sites/specrider",
        agentKind: "codex",
      }),
    );
    expect(screen.getByText("~/Sites/specrider")).toBeTruthy();

    await user.click(
      screen.getByRole("button", { name: "Close agent terminal" }),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("handles copy, SIGINT, paste, focus escape, mouse focus, and scrubbed errors", async () => {
    const onClose = vi.fn();
    terminalSessionMocks.session.status = "error";
    terminalSessionMocks.session.error = "No such file or directory: codex";
    render(
      <TerminalPane
        open={true}
        cwd="/Users/jake/Sites/specrider"
        initialAgent="codex"
        onClose={onClose}
      />,
    );

    expect(screen.getByRole("alert").textContent).toContain(
      "is codex on your PATH?",
    );

    const host = document.querySelector(".terminal-pane-host") as HTMLElement;
    terminalSessionMocks.term.getSelection.mockReturnValueOnce("selected text");
    fireEvent.keyDown(host, { key: "c", metaKey: true });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("selected text");
    expect(terminalSessionMocks.term.clearSelection).toHaveBeenCalledTimes(1);

    terminalSessionMocks.term.getSelection.mockReturnValueOnce("");
    fireEvent.keyDown(host, { key: "c", ctrlKey: true });
    expect(apiMocks.terminalWrite).toHaveBeenCalledWith("term-1", "\x03");

    const shiftEnter = new KeyboardEvent("keydown", {
      key: "Enter",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    expect(host.dispatchEvent(shiftEnter)).toBe(false);
    expect(apiMocks.terminalWrite).toHaveBeenCalledWith("term-1", "\x1b\r");

    const ctrlEnter = new KeyboardEvent("keydown", {
      key: "Enter",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    expect(host.dispatchEvent(ctrlEnter)).toBe(false);
    expect(apiMocks.terminalWrite).toHaveBeenCalledWith("term-1", "\x1b\r");

    fireEvent.keyDown(host, { key: "v", metaKey: true });
    await waitFor(() =>
      expect(terminalSessionMocks.term.paste).toHaveBeenCalledWith(
        "pasted text",
      ),
    );
    expect(clipboardMocks.readText).toHaveBeenCalled();
    terminalSessionMocks.term.paste.mockClear();

    const menuEvent = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    });
    expect(host.dispatchEvent(menuEvent)).toBe(false);
    await waitFor(() =>
      expect(terminalSessionMocks.term.paste).toHaveBeenCalledWith(
        "pasted text",
      ),
    );
    terminalSessionMocks.term.paste.mockClear();

    const pasteEvent = new Event("paste", {
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(pasteEvent, "clipboardData", {
      value: {
        getData: vi.fn((type: string) =>
          type === "text/plain" ? "paste event text" : "",
        ),
      },
    });
    expect(host.dispatchEvent(pasteEvent)).toBe(false);
    expect(terminalSessionMocks.term.paste).toHaveBeenCalledWith(
      "paste event text",
    );

    fireEvent.mouseDown(host);
    expect(terminalSessionMocks.term.focus).toHaveBeenCalled();

    fireEvent.keyDown(host, { key: "Escape", shiftKey: true });
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Close agent terminal" }),
    );
  });
});

describe("TerminalSpike", () => {
  beforeEach(() => {
    xtermMocks.MockTerminal.instances.length = 0;
  });

  it("initializes xterm, writes the greeting, clears by shortcut, and closes by button or Escape", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<TerminalSpike onClose={onClose} />);

    expect(screen.getByText("xterm.js spike")).toBeTruthy();
    await waitFor(() =>
      expect(xtermMocks.MockTerminal.instances[0]?.write).toHaveBeenCalled(),
    );
    expect(screen.getByText("webgl")).toBeTruthy();

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(xtermMocks.MockTerminal.instances[0]?.clear).toHaveBeenCalled();

    await user.click(
      screen.getByRole("button", { name: "Close terminal spike" }),
    );
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
