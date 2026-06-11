import { createRequire } from "node:module";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const require = createRequire(import.meta.url);

const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  // micromark (via remark-parse) pulls in decode-named-character-reference,
  // whose `browser` build calls document.createElement at module scope.
  // Vite applies the browser export condition to Web Worker bundles too, so
  // the markdown parser worker dies on load ("Can't find variable: document")
  // and every large-doc parse silently falls back to the main thread. Pin
  // the bare specifier to the portable build (its `default` export) so the
  // worker and main thread share one DOM-free implementation. The package is
  // a direct dependency only so this resolve() works under pnpm's strict
  // node_modules layout.
  resolve: {
    alias: {
      "decode-named-character-reference": require.resolve(
        "decode-named-character-reference",
      ),
    },
  },

  // Pre-declare every node_modules entry that's reached only through a
  // dynamic / lazy `import(...)` (TerminalPane, MarkdownEditor,
  // Mermaid, KaTeX, dynamic Tauri APIs). Without this, Vite discovers
  // them on first lazy load and re-runs its dep optimizer, which
  // generates new chunk-*?v=<hash> URLs. The Tauri webview is still
  // holding the previous hash, hits a 504 "Outdated Optimize Dep,"
  // and React's boot dies before `show_window` ever fires — the
  // window stays invisible. Listing them here makes Vite bundle the
  // full set at server start, with one stable hash for the session.
  optimizeDeps: {
    include: [
      "@tauri-apps/api/core",
      "@tauri-apps/api/event",
      "@tauri-apps/api/path",
      "@tauri-apps/api/window",
      "@tauri-apps/plugin-dialog",
      "@tauri-apps/plugin-opener",
      "@tauri-apps/plugin-window-state",
      "@codemirror/autocomplete",
      "@codemirror/commands",
      "@codemirror/lang-markdown",
      "@codemirror/language",
      "@codemirror/language-data",
      "@codemirror/search",
      "@codemirror/state",
      "@codemirror/view",
      "@xterm/xterm",
      "@xterm/addon-fit",
      "@xterm/addon-ligatures",
      "@xterm/addon-web-links",
      "@xterm/addon-webgl",
      "katex",
      "mermaid",
    ],
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore non-frontend output that can churn while
      //    dev server is running.
      ignored: ["**/src-tauri/**", "**/coverage/**"],
    },
  },
}));
