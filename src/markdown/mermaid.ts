/** Mermaid is the heaviest renderer dep (~700 KB). Loaded on demand
 *  the first time a `mermaid` fence is encountered, then cached. */

let mermaidPromise: Promise<typeof import("mermaid").default> | null = null;
let lastTheme: string | null = null;

const cache = new Map<string, string>();
let nextId = 0;

async function loadMermaid(): Promise<typeof import("mermaid").default> {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then((m) => m.default);
  }
  return mermaidPromise;
}

/** Initializes Mermaid for the requested theme name and bumps the
 *  cache when the theme changes — every cached SVG was rendered under
 *  the previous theme's palette and would otherwise look stale. */
async function ensureInitialized(themeName: "light" | "dark"): Promise<void> {
  const mermaid = await loadMermaid();
  if (lastTheme === themeName) return;
  cache.clear();
  mermaid.initialize({
    startOnLoad: false,
    theme: themeName === "dark" ? "dark" : "default",
    securityLevel: "strict",
    fontFamily: "inherit",
    // Mermaid otherwise injects a "💣 Syntax error in text" SVG into
    // whatever container it can find on render failure. Suppress that
    // so the rejection bubbles up and our own MermaidBlock error
    // fallback (`<pre class="mermaid-error">`) is what users see.
    suppressErrorRendering: true,
  });
  lastTheme = themeName;
}

export interface MermaidResult {
  svg: string;
  error?: string;
}

/** Renders a Mermaid source string to inline SVG. Cached per
 *  `(theme, source)` so split-mode typing in unrelated parts of the
 *  document doesn't reflow the diagram. */
export async function renderMermaid(
  source: string,
  themeName: "light" | "dark",
): Promise<MermaidResult> {
  await ensureInitialized(themeName);
  const key = `${themeName}::${source}`;
  const cached = cache.get(key);
  if (cached !== undefined) return { svg: cached };
  const mermaid = await loadMermaid();
  const id = `mermaid-${nextId++}`;
  try {
    const out = await mermaid.render(id, source);
    cache.set(key, out.svg);
    return { svg: out.svg };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { svg: "", error: message };
  }
}
