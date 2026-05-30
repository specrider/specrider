import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";

interface Metrics {
  initMs: number | null;
  rendererMode: "webgl" | "canvas" | "pending";
  webglError: string | null;
  streamMs: number | null;
  streamLines: number;
  worstFrameMs: number | null;
  jsHeapMb: number | null;
}

const STREAM_LINE_COUNT = 10_000;
const FAT_CHUNK_BYTES = 1_000_000;

function buildAnsiStream(lines: number): string {
  const parts: string[] = [];
  for (let i = 0; i < lines; i++) {
    const hue = (i * 7) % 256;
    parts.push(
      `\x1b[38;5;${hue}m[${i.toString().padStart(5, "0")}]\x1b[0m line with ` +
        `\x1b[1mbold\x1b[0m \x1b[3mitalic\x1b[0m \x1b[4munderline\x1b[0m ` +
        `green=\x1b[32m✓\x1b[0m red=\x1b[31m✗\x1b[0m\r\n`,
    );
  }
  return parts.join("");
}

function buildFatChunk(bytes: number): string {
  // One contiguous chunk roughly `bytes` long, with embedded ANSI to
  // make sure the parser handles it under sustained pressure.
  const block =
    "\x1b[36mlorem ipsum dolor sit amet consectetur adipiscing elit \x1b[0m";
  const out: string[] = [];
  let total = 0;
  while (total < bytes) {
    out.push(block);
    total += block.length;
  }
  out.push("\r\n");
  return out.join("");
}

function readJsHeapMb(): number | null {
  // Chromium-only API, but WKWebView on macOS exposes it under
  // performance.memory in recent builds. Returns null on browsers that
  // don't.
  const perf = performance as unknown as {
    memory?: { usedJSHeapSize: number };
  };
  if (perf.memory?.usedJSHeapSize) {
    return Math.round((perf.memory.usedJSHeapSize / 1024 / 1024) * 10) / 10;
  }
  return null;
}

export function TerminalSpike(props: { onClose: () => void }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [metrics, setMetrics] = useState<Metrics>({
    initMs: null,
    rendererMode: "pending",
    webglError: null,
    streamMs: null,
    streamLines: 0,
    worstFrameMs: null,
    jsHeapMb: null,
  });

  const greeting = useMemo(
    () =>
      "\x1b[1;32mxterm.js renderer probe\x1b[0m\r\n" +
      "\x1b[2mPress ⌘B to stream " +
      STREAM_LINE_COUNT.toLocaleString() +
      " ANSI lines.\x1b[0m\r\n" +
      "\x1b[2mPress ⌘L to write a 1 MB chunk in one call.\x1b[0m\r\n" +
      "\x1b[2mPress ⌘K to clear. Esc closes the spike.\x1b[0m\r\n\r\n" +
      "Hello \x1b[1;32mworld\x1b[0m! " +
      "\x1b[31mred\x1b[0m " +
      "\x1b[33myellow\x1b[0m " +
      "\x1b[34mblue\x1b[0m " +
      "\x1b[35mmagenta\x1b[0m " +
      "\x1b[36mcyan\x1b[0m\r\n" +
      "Box: ┌─┐ │·│ └─┘  Powerline:   ▶  Emoji: 🚀 🐙 🪿\r\n",
    [],
  );

  useEffect(() => {
    if (!containerRef.current) return;

    const t0 = performance.now();
    const term = new Terminal({
      fontFamily: '"JetBrains Mono", "SF Mono", Menlo, ui-monospace, monospace',
      fontSize: 13,
      lineHeight: 1.2,
      letterSpacing: 0,
      cursorBlink: true,
      cursorStyle: "block",
      scrollback: 5000,
      theme: {
        background: "#1a1b26",
        foreground: "#c0caf5",
        cursor: "#c0caf5",
        selectionBackground: "#33467c",
        black: "#15161e",
        red: "#f7768e",
        green: "#9ece6a",
        yellow: "#e0af68",
        blue: "#7aa2f7",
        magenta: "#bb9af7",
        cyan: "#7dcfff",
        white: "#a9b1d6",
        brightBlack: "#414868",
        brightRed: "#f7768e",
        brightGreen: "#9ece6a",
        brightYellow: "#e0af68",
        brightBlue: "#7aa2f7",
        brightMagenta: "#bb9af7",
        brightCyan: "#7dcfff",
        brightWhite: "#c0caf5",
      },
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);

    let rendererMode: Metrics["rendererMode"] = "canvas";
    let webglError: string | null = null;
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        // Let xterm fall back to canvas if WebGL drops.
        console.warn("[TerminalSpike] WebGL context lost");
      });
      term.loadAddon(webgl);
      rendererMode = "webgl";
    } catch (e) {
      webglError = e instanceof Error ? e.message : String(e);
    }

    fit.fit();
    term.write(greeting);
    term.focus();

    termRef.current = term;
    fitRef.current = fit;

    const initMs = Math.round((performance.now() - t0) * 10) / 10;
    setMetrics((m) => ({
      ...m,
      initMs,
      rendererMode,
      webglError,
      jsHeapMb: readJsHeapMb(),
    }));

    const onResize = () => fit.fit();
    window.addEventListener("resize", onResize);

    return () => {
      window.removeEventListener("resize", onResize);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [greeting]);

  // Run the streaming benchmark with frame-budget instrumentation.
  const runStream = useCallback(() => {
    const term = termRef.current;
    if (!term) return;
    const payload = buildAnsiStream(STREAM_LINE_COUNT);
    const lineCount = STREAM_LINE_COUNT;

    let worstFrame = 0;
    let lastFrame = performance.now();
    let stop = false;
    function rafProbe() {
      if (stop) return;
      const now = performance.now();
      const delta = now - lastFrame;
      if (delta > worstFrame) worstFrame = delta;
      lastFrame = now;
      requestAnimationFrame(rafProbe);
    }
    requestAnimationFrame(rafProbe);

    const t0 = performance.now();
    // xterm.js coalesces writes; the callback fires after the write is
    // queued and (in practice) rendered on the next frame.
    term.write(payload, () => {
      stop = true;
      const streamMs = Math.round(performance.now() - t0);
      setMetrics((m) => ({
        ...m,
        streamMs,
        streamLines: lineCount,
        worstFrameMs: Math.round(worstFrame * 10) / 10,
        jsHeapMb: readJsHeapMb(),
      }));
    });
  }, []);

  const runFatChunk = useCallback(() => {
    const term = termRef.current;
    if (!term) return;
    const payload = buildFatChunk(FAT_CHUNK_BYTES);
    const t0 = performance.now();
    term.write(payload, () => {
      const ms = Math.round(performance.now() - t0);

      console.info(
        `[TerminalSpike] fat-chunk ${FAT_CHUNK_BYTES.toLocaleString()} bytes in ${ms} ms`,
      );
      setMetrics((m) => ({ ...m, jsHeapMb: readJsHeapMb() }));
    });
  }, []);

  const runClear = useCallback(() => {
    termRef.current?.clear();
  }, []);

  // Keyboard shortcuts on the overlay; xterm captures most keys when
  // focused, so we listen on window with capture=true to intercept
  // ⌘B / ⌘L / ⌘K / Esc before xterm sees them.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta && e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        props.onClose();
        return;
      }
      if (!meta) return;
      if (e.key.toLowerCase() === "b") {
        e.preventDefault();
        e.stopPropagation();
        runStream();
      } else if (e.key.toLowerCase() === "l") {
        e.preventDefault();
        e.stopPropagation();
        runFatChunk();
      } else if (e.key.toLowerCase() === "k") {
        e.preventDefault();
        e.stopPropagation();
        runClear();
      }
    }
    window.addEventListener("keydown", onKey, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKey, { capture: true });
  }, [props, runStream, runFatChunk, runClear]);

  return (
    <div className="terminal-spike-overlay">
      <div className="terminal-spike-panel">
        <div className="terminal-spike-header">
          <strong>xterm.js spike</strong>
          <span className="terminal-spike-metric">
            init: {metrics.initMs == null ? "…" : `${metrics.initMs} ms`}
          </span>
          <span className="terminal-spike-metric">
            renderer:&nbsp;
            <span
              style={{
                color:
                  metrics.rendererMode === "webgl"
                    ? "#9ece6a"
                    : metrics.rendererMode === "canvas"
                      ? "#e0af68"
                      : "#a9b1d6",
              }}
            >
              {metrics.rendererMode}
            </span>
            {metrics.webglError ? (
              <span title={metrics.webglError}> (fallback)</span>
            ) : null}
          </span>
          <span className="terminal-spike-metric">
            stream:&nbsp;
            {metrics.streamMs == null
              ? "—"
              : `${metrics.streamLines.toLocaleString()} lines in ${metrics.streamMs} ms`}
          </span>
          <span className="terminal-spike-metric">
            worst frame:&nbsp;
            {metrics.worstFrameMs == null ? "—" : `${metrics.worstFrameMs} ms`}
          </span>
          <span className="terminal-spike-metric">
            jsHeap:&nbsp;
            {metrics.jsHeapMb == null ? "n/a" : `${metrics.jsHeapMb} MB`}
          </span>
          <button
            type="button"
            className="terminal-spike-close"
            onClick={props.onClose}
            aria-label="Close terminal spike"
          >
            ×
          </button>
        </div>
        <div ref={containerRef} className="terminal-spike-host" />
      </div>
    </div>
  );
}
