export interface ResolvedImage {
  /** URL to feed into `<img src>`. Empty when the reference was
   *  refused (currently: external SVGs, which carry a richer
   *  rendering surface than raster formats). */
  src: string;
  /** Whether the source is a remote (`https://`) URL. Callers may
   *  use this to apply extra mitigations (e.g. `referrerpolicy`). */
  remote: boolean;
  /** True when we deliberately refused to load this image. The
   *  caller should render the broken-image / placeholder UI. The
   *  `reason` field disambiguates: `"scheme"` refusals are permanent
   *  (the user can't unblock a `javascript:` ref), while `"untrusted"`
   *  refusals are click-to-load placeholders the user can override. */
  blocked: boolean;
  /** Why the image was blocked. `null` when not blocked. */
  reason: BlockReason | null;
}

export type BlockReason =
  /** Scheme outside the allowlist (`javascript:`, `file:`, etc.) or
   *  an empty/whitespace ref. */
  | "scheme"
  /** External SVG — refused regardless of trust state. */
  | "svg"
  /** Remote ref refused because the workspace isn't trusted. The
   *  caller should render the click-to-load placeholder. */
  | "untrusted";

export interface ImageSrcOptions {
  /** When `false`, remote (`https://`) refs return `blocked: true`
   *  with `reason: "untrusted"`. Defaults to `true` so unit tests and
   *  pre-trust-aware callers keep the prior behavior. */
  remoteAllowed?: boolean;
}

/** Resolves a markdown image `src` to a webview-loadable URL.
 *
 * - `https?://` and `data:` references pass through untouched, with
 *   one exception: remote `.svg` is refused (`blocked: true`). SVGs
 *   are XML and have a wider attack surface than raster formats —
 *   even though `<img src=svg>` cannot run script, we keep the
 *   policy strict for plans authored by third parties.
 * - Plans-root-absolute (`/foo.png`) and plan-relative (`./foo.png`,
 *   `../shared/foo.png`) references are normalized into a path that's
 *   relative to the plans root and handed to the
 *   `specrider-img://localhost/...` custom protocol. The protocol
 *   handler resolves against the active window's plans root and
 *   refuses any path that escapes it.
 *
 * `planPath` is the active plan's plans-root-relative path with
 * forward slashes (matching `Plan.path`). `ref` is the raw source
 * reference as written in the markdown.
 */
export function imageSrc(
  planPath: string | null,
  ref: string,
  options: ImageSrcOptions = {},
): ResolvedImage {
  const remoteAllowed = options.remoteAllowed ?? true;
  const trimmed = ref.trim();
  if (!trimmed)
    return { src: "", remote: false, blocked: true, reason: "scheme" };
  // Refuse anything with a scheme other than the explicit allowlist.
  // `javascript:`, `vbscript:`, and `file:` would otherwise either
  // execute on attribute parsing or leak local-disk reads outside
  // the plans-root sandbox.
  const schemeMatch = trimmed.match(/^([a-z][a-z0-9+.-]*):/i);
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase();
    if (scheme === "https" || scheme === "http") {
      if (isSvgUrl(trimmed)) {
        return { src: "", remote: true, blocked: true, reason: "svg" };
      }
      if (!remoteAllowed) {
        // Preserve the original ref so the placeholder can show it
        // and a click-to-load can re-fetch with `remoteAllowed: true`
        // once the user opts in for this render.
        return {
          src: trimmed,
          remote: true,
          blocked: true,
          reason: "untrusted",
        };
      }
      return { src: trimmed, remote: true, blocked: false, reason: null };
    }
    if (scheme === "data" || scheme === "blob") {
      return { src: trimmed, remote: false, blocked: false, reason: null };
    }
    return { src: "", remote: false, blocked: true, reason: "scheme" };
  }

  const cleaned = trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;
  const planDir = planPath ? planPath.split("/").slice(0, -1) : [];
  const refIsAbsolute = trimmed.startsWith("/");
  const baseSegs = refIsAbsolute ? [] : planDir;
  const resolved = normalizePathSegments([...baseSegs, ...cleaned.split("/")]);
  return {
    src: `specrider-img://localhost/${encodeURIComponent(resolved)}`,
    remote: false,
    blocked: false,
    reason: null,
  };
}

function isSvgUrl(url: string): boolean {
  // Strip query / fragment before extension check so
  // `https://x/y.svg?cache=1` still trips the guard.
  const noQuery = url.split(/[?#]/, 1)[0];
  return /\.svg$/i.test(noQuery);
}

/** Collapses `.` and `..` against earlier segments. Leading `..`s
 *  that walk above the plans root are preserved so the protocol
 *  handler's traversal guard rejects them — better to fail loudly
 *  than silently rewrite to root. */
function normalizePathSegments(segments: string[]): string {
  const out: string[] = [];
  for (const seg of segments) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") {
        out.pop();
      } else {
        out.push("..");
      }
      continue;
    }
    out.push(seg);
  }
  return out.join("/");
}
