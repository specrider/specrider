// Owns the xterm.js Terminal lifecycle inside a React component, plus
// the round-trip to a Rust-side PTY session via the terminal_* commands
// in src/tauri/api.ts. Designed so:
//
//  1. Mounting/unmounting the component (or remounting after an HMR
//     edit) does NOT kill the Rust session — the consumer decides
//     when to call kill(). On remount the consumer re-attaches by
//     calling attach(savedSessionId) and the hook backfills via
//     terminal_replay before resuming live event subscription.
//  2. start() spawns a fresh PTY session, subscribes to its output,
//     and wires term.onData → terminal_write.
//  3. fit() drives an FitAddon refit + a terminal_resize round-trip so
//     command-line apps see the right cols/rows.

import type { UnlistenFn } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { FitAddon } from "@xterm/addon-fit";
import { LigaturesAddon } from "@xterm/addon-ligatures";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import { useCallback, useEffect, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import {
  type AgentKind,
  base64ToBytes,
  listTerminalSessions,
  onTerminalError,
  onTerminalExited,
  onTerminalOutput,
  type SessionMeta,
  type TerminalErrorEvent,
  type TerminalExitedEvent,
  type TerminalOutputEvent,
  terminalKill,
  terminalReplay,
  terminalResize,
  terminalStart,
  terminalWrite,
} from "../tauri/api";

export type TerminalStatus =
  | "idle"
  | "starting"
  | "running"
  | "exited"
  | "error";

export interface UseTerminalSessionOptions {
  /** Theme, font, and spacing updates apply after mount through
   *  `term.options.theme` reassignment without remounting. */
  fontFamily?: string;
  fontSize?: number;
  lineHeight?: number;
  letterSpacing?: number;
  scrollback?: number;
  theme?: Terminal["options"]["theme"];
  /** Mirror canvas-painted terminal output into a hidden textarea so
   *  screen readers can read it. Off by default — synthesizing the
   *  mirror is non-trivial under heavy output (e.g. `find /`). */
  screenReaderMode?: boolean;
}

export interface UseTerminalSessionResult {
  containerRef: React.RefObject<HTMLDivElement | null>;
  status: TerminalStatus;
  session: SessionMeta | null;
  /** Last error message — populated when status is "error", or when a
   *  command (start / kill) rejects. Cleared on the next successful
   *  start/attach. */
  error: string | null;
  /** xterm.js exit code if the session has exited; null otherwise. */
  exitCode: number | null;
  start: (args: {
    cwd: string;
    command?: string[];
    agentKind: AgentKind;
  }) => Promise<SessionMeta | null>;
  attach: (sessionId: string) => Promise<SessionMeta | null>;
  kill: () => Promise<void>;
  /** Forces a FitAddon refit and rounds-trips the new cols/rows to
   *  Rust. Call after the host element resizes. */
  fit: () => void;
  /** Underlying xterm.js Terminal — exposed for advanced use only
   *  (theme tuning, addons). null until the host is mounted. */
  term: Terminal | null;
  /** Live cwd reported by the shell via OSC 7 (`\e]7;file://host/path\a`).
   *  Null until the shell emits its first OSC 7, which most macOS
   *  default zsh/bash configs do on every prompt. Consumers should
   *  fall back to the start-time cwd while this is null. */
  cwd: string | null;
}

const DEFAULT_FONT =
  '"JetBrains Mono", "SF Mono", Menlo, ui-monospace, monospace';
const MIN_START_COLS = 20;
const MIN_START_ROWS = 5;
const START_GEOMETRY_TIMEOUT_MS = 700;
const STABLE_GEOMETRY_FRAMES = 2;

/** Resolves a CSS color value (oklch, hsl, named, etc.) to a string
 *  xterm.js can parse — the WebGL renderer is strict about this and
 *  some color spaces (oklch in particular) only round-trip cleanly via
 *  the browser's own normalization. */
function resolveColor(cssValue: string, fallback: string): string {
  const v = cssValue.trim();
  if (!v) return fallback;
  const probe = document.createElement("div");
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  probe.style.color = v;
  document.body.appendChild(probe);
  const rgb = getComputedStyle(probe).color;
  document.body.removeChild(probe);
  return rgb || fallback;
}

/** Reads --term-* CSS variables off :root and assembles an xterm
 *  theme. ANSI 16 colors fall back to xterm's defaults when the
 *  matching variable isn't set. */
function readThemeFromCss(): NonNullable<Terminal["options"]["theme"]> {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string) => cs.getPropertyValue(name).trim();

  const bg = resolveColor(
    v("--term-bg") || v("--reader-bg") || v("--paper"),
    "#1a1b26",
  );
  const fg = resolveColor(v("--term-fg") || v("--ink"), "#c0caf5");
  const cursor = resolveColor(
    v("--term-cursor") || v("--accent") || v("--ink"),
    "#c0caf5",
  );
  const cursorAccent = resolveColor(
    v("--term-cursor-accent") || v("--paper"),
    "#1a1b26",
  );
  const selection = resolveColor(
    v("--term-selection") || v("--accent-soft"),
    "#33467c",
  );

  const ansi: Record<string, string | undefined> = {
    black: v("--term-ansi-black"),
    red: v("--term-ansi-red"),
    green: v("--term-ansi-green"),
    yellow: v("--term-ansi-yellow"),
    blue: v("--term-ansi-blue"),
    magenta: v("--term-ansi-magenta"),
    cyan: v("--term-ansi-cyan"),
    white: v("--term-ansi-white"),
    brightBlack: v("--term-ansi-bright-black"),
    brightRed: v("--term-ansi-bright-red"),
    brightGreen: v("--term-ansi-bright-green"),
    brightYellow: v("--term-ansi-bright-yellow"),
    brightBlue: v("--term-ansi-bright-blue"),
    brightMagenta: v("--term-ansi-bright-magenta"),
    brightCyan: v("--term-ansi-bright-cyan"),
    brightWhite: v("--term-ansi-bright-white"),
  };
  const resolvedAnsi: Record<string, string> = {};
  for (const [k, val] of Object.entries(ansi)) {
    if (val) resolvedAnsi[k] = resolveColor(val, "");
  }

  return {
    background: bg,
    foreground: fg,
    cursor,
    cursorAccent,
    selectionBackground: selection,
    ...resolvedAnsi,
  };
}

export function useTerminalSession(
  opts: UseTerminalSessionOptions = {},
): UseTerminalSessionResult {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const dataDisposableRef = useRef<{ dispose: () => void } | null>(null);
  const unlistenersRef = useRef<UnlistenFn[]>([]);

  const [status, setStatus] = useState<TerminalStatus>("idle");
  const [session, setSession] = useState<SessionMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exitCode, setExitCode] = useState<number | null>(null);
  // Live cwd from the shell's OSC 7 emissions. The session's start cwd
  // is the fallback in TerminalPane until this updates.
  const [cwd, setCwd] = useState<string | null>(null);

  // Mount the xterm Terminal once. Theme/font option updates happen
  // separately so we don't need to dispose+recreate on a settings tweak.
  useEffect(() => {
    if (!containerRef.current) return;
    const term = new Terminal({
      fontFamily: opts.fontFamily ?? DEFAULT_FONT,
      fontSize: opts.fontSize ?? 13,
      lineHeight: opts.lineHeight ?? 1.2,
      letterSpacing: opts.letterSpacing ?? 0,
      scrollback: opts.scrollback ?? 5000,
      cursorBlink: true,
      cursorStyle: "block",
      theme: opts.theme ?? readThemeFromCss(),
      // Auto-bump any fg/bg combo below WCAG AA — fixes dimmed text
      // (SGR \e[2m, used heavily by Claude Code for muted lines) fading
      // into near-white on light themes.
      minimumContrastRatio: 4.5,
      // ConPTY/Windows tweak — harmless on macOS/Linux.
      allowProposedApi: true,
      screenReaderMode: opts.screenReaderMode ?? false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    try {
      const webgl = new WebglAddon();
      term.loadAddon(webgl);
    } catch {
      // WebGL fallback — xterm.js falls back to canvas automatically.
    }
    // WebLinksAddon underlines URLs and routes clicks through Tauri's
    // opener plugin so they open in the user's default browser rather
    // than navigating the webview.
    term.loadAddon(
      new WebLinksAddon((event, uri) => {
        event.preventDefault();
        void openUrl(uri).catch(() => {
          // Last-resort fallback if the opener plugin fails or isn't
          // permitted; window.open is also blocked by Tauri's CSP, so
          // we just no-op.
        });
      }),
    );
    // OSC 7 — shells emit `\e]7;file://hostname/path\a` on every
    // prompt to report their current working directory. We parse it
    // out here so the header in TerminalPane can stay in sync with
    // wherever the user has cd'd. Returning true tells xterm we've
    // consumed the sequence so it isn't echoed to the screen.
    term.parser.registerOscHandler(7, (data) => {
      const match = /^file:\/\/[^/]*(\/.*)$/.exec(data);
      if (!match) return false;
      try {
        setCwd(decodeURIComponent(match[1]));
      } catch {
        return false;
      }
      return true;
    });
    // Ligatures addon — opt-in via the existing Settings → Typography
    // "Code ligatures" toggle. Reads the body class that useApplyCss
    // keeps in sync. Requires the WebGL renderer; harmless if WebGL
    // failed and we fell back to canvas (the addon just no-ops).
    if (document.body.classList.contains("mono-ligatures")) {
      try {
        term.loadAddon(new LigaturesAddon());
      } catch {
        // ignore — addon needs WebGL; fall through to plain rendering.
      }
    }
    // Defer the first fit() to the next animation frame: term.open()
    // schedules the renderer's first paint asynchronously, and
    // FitAddon reads `_renderer.dimensions` which is undefined until
    // that paint completes. Calling fit() synchronously here races on
    // multi-window setups where the second window's renderer hasn't
    // fired its first frame yet. The existing ResizeObserver in the
    // consuming component will redo the fit once the host actually
    // settles.
    requestAnimationFrame(() => {
      if (
        containerRef.current &&
        containerRef.current.clientWidth > 0 &&
        containerRef.current.clientHeight > 0
      ) {
        try {
          fit.fit();
        } catch {
          // Renderer dimensions still not ready — let ResizeObserver
          // retry on the first real layout pulse.
        }
      }
    });
    termRef.current = term;
    fitRef.current = fit;
    return () => {
      try {
        dataDisposableRef.current?.dispose();
      } catch {
        // ignore
      }
      dataDisposableRef.current = null;
      unlistenersRef.current.forEach((un) => {
        try {
          un();
        } catch {
          // ignore
        }
      });
      unlistenersRef.current = [];
      try {
        term.dispose();
      } catch {
        // ignore
      }
      termRef.current = null;
      fitRef.current = null;
      // Note: we intentionally don't terminalKill() here — see hook
      // docstring. The Rust session keeps running so a remount can
      // reattach.
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    opts.letterSpacing,
    opts.scrollback,
    opts.fontSize,
    opts.theme,
    opts.screenReaderMode,
    opts.lineHeight,
    opts.fontFamily,
  ]);

  /** Wrap every external fit() call so a not-yet-rendered terminal
   *  doesn't throw `_renderer.value.dimensions is undefined`. Also
   *  short-circuits when the host has zero dimensions (display:none
   *  parent, drawer collapsed, etc.). */
  const safeFit = useCallback((): boolean => {
    const fitAddon = fitRef.current;
    const host = containerRef.current;
    if (!fitAddon || !host) return false;
    if (host.clientWidth <= 0 || host.clientHeight <= 0) return false;
    // The center column animates open over ~180ms (grid-template-columns
    // transition), so during that window the host is a sliver and a fit()
    // would collapse xterm to a column or two — the shell's first prompt
    // then wraps into a tall smear that only clears on the post-animation
    // refit. Skip fitting until the proposed geometry is plausible; xterm
    // stays at its construction default (80×24) meanwhile, the host clips
    // it (overflow:hidden), and the ResizeObserver fires again once the
    // animation settles. A real terminal pane is always far wider than
    // this floor, so legitimately-sized panes are never starved.
    const proposed = fitAddon.proposeDimensions();
    if (
      !proposed ||
      proposed.cols < MIN_START_COLS ||
      proposed.rows < MIN_START_ROWS
    ) {
      return false;
    }
    try {
      fitAddon.fit();
      return true;
    } catch {
      // ignore — likely renderer not ready yet
      return false;
    }
  }, []);

  // Apply theme/font option changes without recreating the terminal.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    if (opts.fontFamily) term.options.fontFamily = opts.fontFamily;
    if (opts.fontSize) term.options.fontSize = opts.fontSize;
    if (opts.lineHeight) term.options.lineHeight = opts.lineHeight;
    if (opts.letterSpacing != null)
      term.options.letterSpacing = opts.letterSpacing;
    if (opts.scrollback) term.options.scrollback = opts.scrollback;
    if (opts.theme) term.options.theme = opts.theme;
    safeFit();
  }, [
    opts.fontFamily,
    opts.fontSize,
    opts.lineHeight,
    opts.letterSpacing,
    opts.scrollback,
    opts.theme,
    safeFit,
  ]);

  // Re-read --term-* CSS variables when the SpecRider theme changes
  // (settings-changed broadcasts from the Tauri side trigger CSS
  // updates via useApplyCss). The opts.theme override wins if the
  // caller explicitly provides one.
  useEffect(() => {
    if (opts.theme) return;
    const term = termRef.current;
    if (!term) return;
    const apply = () => {
      term.options.theme = readThemeFromCss();
    };
    // Initial sync in case the CSS-vars resolution ran before the
    // theme was actually applied (theme apply is also a useEffect).
    queueMicrotask(apply);
    // useApplyCss writes CSS custom properties on document.documentElement
    // (style attribute mutation) and toggles body classes
    // (theme-light / theme-dark). Watch both so we re-sync the xterm
    // theme without coupling to the settings module.
    const obs = new MutationObserver(() => apply());
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["style", "class"],
    });
    obs.observe(document.body, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => obs.disconnect();
  }, [opts.theme]);

  const wireSessionListeners = useCallback((sessionId: string) => {
    // Drop any prior subscriptions before wiring fresh ones.
    dataDisposableRef.current?.dispose();
    dataDisposableRef.current = null;
    unlistenersRef.current.forEach((un) => {
      un();
    });
    unlistenersRef.current = [];

    const term = termRef.current;
    if (!term) return;

    dataDisposableRef.current = term.onData((data) => {
      void terminalWrite(sessionId, data).catch((e) =>
        setError(e instanceof Error ? e.message : String(e)),
      );
    });

    void Promise.all([
      onTerminalOutput((e: TerminalOutputEvent) => {
        if (e.sessionId !== sessionId) return;
        const bytes = base64ToBytes(e.chunkB64);
        term.write(bytes);
      }),
      onTerminalExited((e: TerminalExitedEvent) => {
        if (e.sessionId !== sessionId) return;
        setStatus("exited");
        setExitCode(e.exitCode);
      }),
      onTerminalError((e: TerminalErrorEvent) => {
        if (e.sessionId !== sessionId) return;
        setError(e.message);
        setStatus("error");
      }),
    ]).then((unlisteners) => {
      // If the hook was already torn down (component unmounted before
      // listen() resolved), drop the listeners immediately.
      if (sessionIdRef.current !== sessionId) {
        unlisteners.forEach((un) => {
          un();
        });
        return;
      }
      unlistenersRef.current.push(...unlisteners);
    });
  }, []);

  const fit = useCallback(() => {
    const term = termRef.current;
    if (!term) return;
    const didFit = safeFit();
    const sessionId = sessionIdRef.current;
    if (didFit && sessionId && term.cols > 0 && term.rows > 0) {
      void terminalResize(sessionId, term.cols, term.rows).catch((e) =>
        setError(e instanceof Error ? e.message : String(e)),
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [safeFit]);

  const waitForStableGeometry = useCallback(
    async (fitAddon: FitAddon): Promise<void> => {
      const host = containerRef.current;
      if (!host) return;

      const deadline = performance.now() + START_GEOMETRY_TIMEOUT_MS;
      let stableFrames = 0;
      let lastCols = 0;
      let lastRows = 0;

      while (performance.now() < deadline) {
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve()),
        );

        if (host.clientWidth <= 0 || host.clientHeight <= 0) {
          stableFrames = 0;
          continue;
        }

        let proposed: { cols: number; rows: number } | undefined;
        try {
          proposed = fitAddon.proposeDimensions() ?? undefined;
        } catch {
          stableFrames = 0;
          continue;
        }

        if (
          !proposed ||
          proposed.cols < MIN_START_COLS ||
          proposed.rows < MIN_START_ROWS
        ) {
          stableFrames = 0;
          continue;
        }

        if (proposed.cols === lastCols && proposed.rows === lastRows) {
          stableFrames += 1;
        } else {
          stableFrames = 1;
          lastCols = proposed.cols;
          lastRows = proposed.rows;
        }

        if (stableFrames >= STABLE_GEOMETRY_FRAMES) break;
      }

      safeFit();
    },
    [safeFit],
  );

  const start = useCallback(
    async (args: {
      cwd: string;
      agentKind: AgentKind;
    }): Promise<SessionMeta | null> => {
      const term = termRef.current;
      const fitAddon = fitRef.current;
      if (!term || !fitAddon) {
        const msg = "terminal not mounted yet";
        setError(msg);
        setStatus("error");
        return null;
      }
      // Wait until the pane has a stable, plausible geometry before
      // spawning the shell. If the PTY starts while the action column is
      // still animating open, zsh/readline can paint for stale columns and
      // every subsequent prompt redraw lands in the wrong place.
      await waitForStableGeometry(fitAddon);
      // The center column animates open over ~180ms (grid-template-columns
      // transition), so a fit() during that window can measure the host at
      // a sliver width and report only a column or two. Spawning the shell
      // that narrow makes its first prompt wrap into a tall smear until the
      // post-animation refit. Treat an implausibly small measurement as
      // "not settled yet" and spawn at the standard 80×24 instead; the
      // ResizeObserver pulse after the animation round-trips the true size.
      const cols = term.cols >= MIN_START_COLS ? term.cols : 80;
      const rows = term.rows >= MIN_START_ROWS ? term.rows : 24;
      setStatus("starting");
      setError(null);
      setExitCode(null);
      setCwd(null);
      try {
        const meta = await terminalStart({
          cwd: args.cwd,
          agentKind: args.agentKind,
          cols,
          rows,
        });
        sessionIdRef.current = meta.id;
        setSession(meta);
        wireSessionListeners(meta.id);
        setStatus("running");
        term.focus();
        return meta;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        setStatus("error");
        return null;
      }
    },
    [wireSessionListeners, waitForStableGeometry],
  );

  const attach = useCallback(
    async (sessionId: string): Promise<SessionMeta | null> => {
      const term = termRef.current;
      if (!term) {
        const msg = "terminal not mounted yet";
        setError(msg);
        setStatus("error");
        return null;
      }
      setStatus("starting");
      setError(null);
      try {
        // Validate the session still exists for this window. If the
        // Rust side already cleaned it up (window close, crash), bail
        // before pretending we attached.
        const sessions = await listTerminalSessions();
        const meta = sessions.find((s) => s.id === sessionId) ?? null;
        if (!meta) {
          setStatus("idle");
          return null;
        }
        // Backfill scrollback from the ring buffer before we light up
        // live subscriptions, otherwise a chunk that arrived between
        // replay() and the listener could be ordered after the replay
        // bytes in the visible scrollback.
        sessionIdRef.current = meta.id;
        setSession(meta);
        wireSessionListeners(meta.id);
        const replayed = await terminalReplay(meta.id);
        if (replayed.byteLength > 0) {
          term.write(replayed);
        }
        // Re-sync size in case the host's container changed dimensions
        // while the webview was detached.
        safeFit();
        if (term.cols > 0 && term.rows > 0) {
          await terminalResize(meta.id, term.cols, term.rows);
        }
        setStatus("running");
        term.focus();
        return meta;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        setStatus("error");
        return null;
      }
    },
    [wireSessionListeners, safeFit],
  );

  const kill = useCallback(async (): Promise<void> => {
    const sessionId = sessionIdRef.current;
    if (!sessionId) return;
    try {
      await terminalKill(sessionId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  return {
    containerRef,
    status,
    session,
    error,
    exitCode,
    start,
    attach,
    kill,
    fit,
    term: termRef.current,
    cwd,
  };
}
