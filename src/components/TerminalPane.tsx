// When the user opens the agent terminal, the center column subdivides
// into [Reader-or-Editor] | [TerminalPane] with a draggable column
// splitter. This component is just the right half — sizing is owned by
// the parent grid; we fill our cell.
//
// Wraps useTerminalSession in actual UI: a header strip with the
// session's agent badge + cwd + agent picker + Close, and the xterm
// host itself. Keystrokes go through xterm's own input path; we
// intercept Cmd+C (selection-aware copy, SIGINT fallback) and paste
// paths (term.paste so bracketed-paste works), plus modified Enter for
// multiline prompts.

import { readText as readClipboardText } from "@tauri-apps/plugin-clipboard-manager";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTerminalSession } from "../hooks/useTerminalSession";
import { useSettings } from "../settings/store";
import { type AgentKind, terminalSetCwd, terminalWrite } from "../tauri/api";
import { Icon } from "./icons";

const FIT_DEBOUNCE_MS = 50;
const PROMPT_MULTILINE_ENTER = "\x1b\r";

export interface TerminalPaneProps {
  open: boolean;
  cwd: string;
  cwdRequest?: { seq: number; cwd: string } | null;
  /** Agent to launch on first open. */
  initialAgent: AgentKind;
  onClose: () => void;
}

// xterm wants a full CSS font-family stack; the user setting is just a
// family name (e.g. "JetBrains Mono"). Wrap it in quotes when needed
// and append the same fallbacks the rest of the app uses.
function termFontFamily(family: string): string {
  const trimmed = family.trim();
  const quoted =
    /[\s,]/.test(trimmed) &&
    !trimmed.startsWith('"') &&
    !trimmed.startsWith("'")
      ? `"${trimmed}"`
      : trimmed;
  return `${quoted}, "SF Mono", Menlo, ui-monospace, monospace`;
}

function shortenCwd(cwd: string, home: string | null): string {
  if (!cwd) return "";
  if (home && cwd === home) return "~";
  if (home && cwd.startsWith(`${home}/`)) return `~${cwd.slice(home.length)}`;
  // Show last two segments to keep the header tight.
  const parts = cwd.split("/").filter(Boolean);
  if (parts.length <= 2) return cwd;
  return `.../${parts.slice(-2).join("/")}`;
}

export function TerminalPane(props: TerminalPaneProps) {
  // Defer the inner mount until the user has opened the pane at least
  // once. After first open, stay mounted and just hide via CSS.
  const [hasOpened, setHasOpened] = useState(false);
  useEffect(() => {
    if (props.open) setHasOpened(true);
  }, [props.open]);
  if (!hasOpened) return null;
  return <TerminalPaneInner {...props} />;
}

function TerminalPaneInner(props: TerminalPaneProps) {
  const { open, cwd, cwdRequest, initialAgent, onClose } = props;

  const [home, setHome] = useState<string | null>(null);

  const { effective: settings } = useSettings();
  const session = useTerminalSession({
    fontFamily: termFontFamily(settings.fontMono),
    fontSize: settings.monoSize,
    screenReaderMode: settings.terminalAnnounceOutput,
  });
  const startedRef = useRef(false);
  const appliedCwdRequestSeqRef = useRef(0);

  // Resolve $HOME once for cwd shortening in the header.
  useEffect(() => {
    let cancelled = false;
    void import("@tauri-apps/api/path").then(({ homeDir }) =>
      homeDir().then((h) => {
        if (!cancelled) setHome(h);
      }),
    );
    return () => {
      cancelled = true;
    };
  }, []);

  // Auto-start once when the pane first opens.
  useEffect(() => {
    if (!open) return;
    if (startedRef.current) return;
    if (session.status !== "idle") return;
    startedRef.current = true;
    void session.start({
      cwd,
      agentKind: initialAgent,
    });
  }, [open, initialAgent, cwd, session]);

  // Follow the reader/diff pane focus by asking Rust to emit a
  // validated `cd` command into the PTY. We key this off an explicit
  // sequence from App.tsx instead of raw prop changes so a manual `cd`
  // inside the terminal stays sticky until the next real pane-focus
  // transition.
  useEffect(() => {
    if (!cwdRequest || cwdRequest.seq <= 0) return;
    if (appliedCwdRequestSeqRef.current === cwdRequest.seq) return;
    if (session.status !== "running") return;
    const sessionId = session.session?.id;
    if (!sessionId) return;
    const currentCwd = session.cwd ?? session.session?.cwd ?? null;
    appliedCwdRequestSeqRef.current = cwdRequest.seq;
    if (currentCwd === cwdRequest.cwd) return;
    void terminalSetCwd(sessionId, cwdRequest.cwd).catch((e) =>
      console.error("terminal_set_cwd failed:", e),
    );
  }, [
    cwdRequest,
    session.cwd,
    session.session?.cwd,
    session.session?.id,
    session.status,
  ]);

  // ResizeObserver-driven fit so dragging the parent splitter reflows
  // command-line apps. 50ms debounce keeps fit() out of the drag's
  // hot path.
  useEffect(() => {
    if (!session.containerRef.current) return;
    const el = session.containerRef.current;
    let timer: number | null = null;
    const ro = new ResizeObserver(() => {
      if (timer != null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        session.fit();
        timer = null;
      }, FIT_DEBOUNCE_MS);
    });
    ro.observe(el);
    return () => {
      if (timer != null) window.clearTimeout(timer);
      ro.disconnect();
    };
  }, [session]);

  // Keyboard intercepts on the host: ⌘⇧Esc to release focus back to
  // the surrounding UI (xterm captures every keystroke including Tab,
  // so this chord is the only deterministic way out for keyboard
  // users), Cmd+C (selection-aware copy, SIGINT fallback when no
  // selection), Cmd+V (route through term.paste so bracketed-paste
  // mode works correctly), and Shift/Ctrl+Enter (multiline prompt).
  const onHostKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      // ⌘⇧Esc / Ctrl+Shift+Esc — escape from the terminal. We can't
      // bind plain Esc because it's a real key inside the terminal
      // (vim, less, etc. need it). Shift+Esc combo is unused by
      // standard PTY apps.
      if (e.key === "Escape" && e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        // Move focus to the close button so keyboard users land on a
        // recognizable, dismissable surface. From there Tab proceeds
        // through the rest of the chrome.
        const host = e.currentTarget;
        const close = host
          .closest(".terminal-pane")
          ?.querySelector<HTMLButtonElement>(".terminal-pane-close");
        close?.focus();
        return;
      }
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      const term = session.term;
      const sessionId = session.session?.id;
      if (!term || !sessionId) return;

      const key = e.key.toLowerCase();
      if (key === "c") {
        const selection = term.getSelection();
        if (selection && selection.length > 0) {
          e.preventDefault();
          void navigator.clipboard.writeText(selection).catch(() => {
            // Clipboard refusals usually mean a CSP gap.
          });
          term.clearSelection();
        } else {
          // No selection — send SIGINT (^C) to the foreground process.
          e.preventDefault();
          void terminalWrite(sessionId, "\x03");
        }
        return;
      }
      if (key === "v") {
        e.preventDefault();
        term.focus();
        void readClipboardText()
          .then((text) => {
            if (text) term.paste(text);
          })
          .catch(() => {
            // ignore — paste isn't available in this context.
          });
      }
    },
    [session.term, session.session],
  );

  const onHostContextMenu = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      const term = session.term;
      const sessionId = session.session?.id;
      if (!term || !sessionId) return;
      term.focus();
      void readClipboardText()
        .then((text) => {
          if (text) term.paste(text);
        })
        .catch(() => {
          // ignore — paste isn't available in this context.
        });
    },
    [session.term, session.session],
  );

  useEffect(() => {
    const host = session.containerRef.current;
    if (!host) return;

    const pasteText = (text: string) => {
      const term = session.term;
      const sessionId = session.session?.id;
      if (!term || !sessionId || !text) return;
      term.focus();
      term.paste(text);
    };

    const pasteFromClipboard = () => {
      const term = session.term;
      const sessionId = session.session?.id;
      if (!term || !sessionId) return;
      term.focus();
      void readClipboardText()
        .then((text) => pasteText(text))
        .catch(() => {
          // ignore — paste isn't available in this context.
        });
    };

    const onKeyDownCapture = (e: KeyboardEvent) => {
      if (
        e.key === "Enter" &&
        (e.shiftKey || e.ctrlKey) &&
        !e.altKey &&
        !e.metaKey
      ) {
        const term = session.term;
        const sessionId = session.session?.id;
        if (!term || !sessionId) return;
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        term.focus();
        void terminalWrite(sessionId, PROMPT_MULTILINE_ENTER);
        return;
      }
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key.toLowerCase() !== "v") return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      pasteFromClipboard();
    };

    const onPasteCapture = (e: ClipboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      pasteText(e.clipboardData?.getData("text/plain") ?? "");
    };

    const onContextMenuCapture = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      pasteFromClipboard();
    };

    host.addEventListener("keydown", onKeyDownCapture, true);
    host.addEventListener("paste", onPasteCapture, true);
    host.addEventListener("contextmenu", onContextMenuCapture, true);
    return () => {
      host.removeEventListener("keydown", onKeyDownCapture, true);
      host.removeEventListener("paste", onPasteCapture, true);
      host.removeEventListener("contextmenu", onContextMenuCapture, true);
    };
  }, [session.containerRef, session.term, session.session]);

  const statusLabel =
    session.status === "starting"
      ? "starting…"
      : session.status === "running"
        ? null
        : session.status === "exited"
          ? `exited${session.exitCode != null ? ` (${session.exitCode})` : ""}`
          : session.status === "error"
            ? "error"
            : "idle";

  // Prefer the live cwd reported by the shell over the start-time
  // cwd so the header tracks `cd` commands. Falls back to the launch
  // path until the first OSC 7 lands.
  const displayCwd = session.cwd ?? cwd;
  const cwdLabel = shortenCwd(displayCwd, home);

  return (
    <section
      className="terminal-pane"
      aria-label="Agent terminal"
      aria-hidden={!open}
    >
      <div className="terminal-pane-header">
        <span className="terminal-pane-icon" aria-hidden="true">
          <Icon.Terminal />
        </span>
        <span className="terminal-pane-title">Terminal</span>
        <span className="terminal-pane-cwd" title={displayCwd}>
          {cwdLabel}
        </span>
        {statusLabel && (
          <span className={`terminal-pane-status status-${session.status}`}>
            {statusLabel}
          </span>
        )}
        <div className="terminal-pane-spacer" />
        <button
          type="button"
          className="terminal-pane-close"
          onClick={onClose}
          aria-label="Close agent terminal"
          title="Close (the session keeps running in the background)"
        >
          ×
        </button>
      </div>
      {session.error && session.status !== "running" && (
        <div className="terminal-pane-error" role="alert">
          {session.error}
          {session.error.toLowerCase().includes("no such file") && (
            <span className="terminal-pane-error-hint">
              {" "}
              · is <code>{initialAgent}</code> on your <code>PATH</code>?
            </span>
          )}
        </div>
      )}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: xterm owns keyboard interaction inside this host. */}
      <div
        ref={session.containerRef}
        className="terminal-pane-host"
        onKeyDown={onHostKeyDown}
        onContextMenu={onHostContextMenu}
        onMouseDown={() => session.term?.focus()}
      />
    </section>
  );
}
