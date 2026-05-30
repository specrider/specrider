import {
  type BundledLanguage,
  type BundledTheme,
  bundledLanguages,
  getSingletonHighlighter,
  type HighlighterGeneric,
} from "shiki";

const LIGHT_THEME: BundledTheme = "github-light";
const DARK_THEME: BundledTheme = "github-dark";

type Highlighter = HighlighterGeneric<BundledLanguage, BundledTheme>;

let highlighterPromise: Promise<Highlighter> | null = null;
let highlighterSync: Highlighter | null = null;
const loadedLangs = new Set<string>();
const loadingLangs = new Map<string, Promise<boolean>>();

function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = getSingletonHighlighter({
      themes: [LIGHT_THEME, DARK_THEME],
      langs: [],
    }).then((hl) => {
      highlighterSync = hl;
      return hl;
    });
  }
  return highlighterPromise;
}

function isBundled(lang: string): lang is BundledLanguage {
  return Object.hasOwn(bundledLanguages, lang);
}

function loadLang(hl: Highlighter, lang: BundledLanguage): Promise<boolean> {
  if (loadedLangs.has(lang)) return Promise.resolve(true);
  let p = loadingLangs.get(lang);
  if (!p) {
    p = hl
      .loadLanguage(lang)
      .then(() => {
        loadedLangs.add(lang);
        return true;
      })
      .catch(() => false)
      .finally(() => {
        loadingLangs.delete(lang);
      });
    loadingLangs.set(lang, p);
  }
  return p;
}

/**
 * Highlight a code block. Returns inline shiki HTML (token spans only, no
 * <pre>/<code> wrapper) using dual themes — each token carries both
 * --shiki-light and --shiki-dark CSS variables, so a single CSS swap on
 * `body.theme-dark` flips the palette without re-rendering.
 *
 * Returns null if the language is unknown or shiki fails — the caller should
 * fall back to rendering the raw text.
 */
export async function highlightCode(
  code: string,
  lang: string,
): Promise<string | null> {
  const normalized = lang.trim().toLowerCase();
  if (
    !normalized ||
    normalized === "text" ||
    normalized === "plain" ||
    normalized === "plaintext"
  ) {
    return null;
  }
  if (!isBundled(normalized)) return null;

  const hl = await getHighlighter();
  const ok = await loadLang(hl, normalized);
  if (!ok) return null;

  try {
    return hl.codeToHtml(code, {
      lang: normalized,
      themes: { light: LIGHT_THEME, dark: DARK_THEME },
      defaultColor: false,
      structure: "inline",
    });
  } catch {
    return null;
  }
}

/** Map of file extension → shiki language id. Falls back to null when
 *  the extension is unknown — caller renders plain text in that case. */
const EXT_LANG: Record<string, string> = {
  ts: "ts",
  tsx: "tsx",
  mts: "ts",
  cts: "ts",
  js: "js",
  jsx: "jsx",
  mjs: "js",
  cjs: "js",
  rs: "rust",
  py: "python",
  pyi: "python",
  go: "go",
  ex: "elixir",
  exs: "elixir",
  heex: "elixir",
  rb: "ruby",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  scala: "scala",
  swift: "swift",
  cs: "csharp",
  fs: "fsharp",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hxx: "cpp",
  hh: "cpp",
  m: "objective-c",
  mm: "objective-cpp",
  md: "markdown",
  mdx: "mdx",
  markdown: "markdown",
  json: "json",
  jsonc: "jsonc",
  json5: "json5",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  sass: "sass",
  less: "less",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  fish: "fish",
  sql: "sql",
  graphql: "graphql",
  gql: "graphql",
  vue: "vue",
  svelte: "svelte",
  astro: "astro",
  php: "php",
  lua: "lua",
  dart: "dart",
  proto: "proto",
  xml: "xml",
  diff: "diff",
  patch: "diff",
  ini: "ini",
  hcl: "hcl",
  tf: "terraform",
  tfvars: "terraform",
  r: "r",
  erl: "erlang",
  hs: "haskell",
  clj: "clojure",
  cljs: "clojure",
  zig: "zig",
  nix: "nix",
  v: "v",
};

/** Detect a shiki language id from a file path. Handles a few extensionless
 *  filenames (Dockerfile, Makefile) by basename. Returns null if unknown. */
export function detectLangFromPath(path: string): string | null {
  const base = (path.split("/").pop() ?? "").toLowerCase();
  if (!base) return null;
  if (base === "dockerfile" || base.startsWith("dockerfile.")) return "docker";
  if (base === "makefile" || base === "gnumakefile") return "make";
  if (base === "cmakelists.txt") return "cmake";
  const idx = base.lastIndexOf(".");
  if (idx < 0) return null;
  const ext = base.slice(idx + 1);
  const lang = EXT_LANG[ext];
  if (!lang) return null;
  return isBundled(lang) ? lang : null;
}

/** Pre-load a shiki language and return true once ready. Idempotent — safe
 *  to call repeatedly with the same lang. */
export async function ensureLanguage(lang: string): Promise<boolean> {
  const normalized = lang.trim().toLowerCase();
  if (!normalized || !isBundled(normalized)) return false;
  const hl = await getHighlighter();
  return loadLang(hl, normalized);
}

/** True when `lang` is loaded and `highlightSync` will succeed. Lets callers
 *  skip the async `ensureLanguage` round-trip when the singleton is warm. */
export function isLangReady(lang: string): boolean {
  if (!highlighterSync) return false;
  const normalized = lang.trim().toLowerCase();
  return loadedLangs.has(normalized);
}

/** Synchronously highlight `code` for `lang`. Requires `ensureLanguage(lang)`
 *  to have resolved truthy first; returns null otherwise. */
export function highlightSync(code: string, lang: string): string | null {
  if (!highlighterSync) return null;
  const normalized = lang.trim().toLowerCase();
  if (!normalized || !isBundled(normalized)) return null;
  if (!loadedLangs.has(normalized)) return null;
  try {
    return highlighterSync.codeToHtml(code, {
      lang: normalized,
      themes: { light: LIGHT_THEME, dark: DARK_THEME },
      defaultColor: false,
      structure: "inline",
    });
  } catch {
    return null;
  }
}
