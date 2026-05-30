import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified } from "unified";

/** Single source of truth for the unified() pipeline used to parse
 *  plan markdown. Both `parse.ts` (main thread) and the parser worker
 *  re-use this so they can't drift on plugin set or order — math
 *  support quietly disappeared from the worker once already, and an
 *  asymmetry there means the renderer and editor see different ASTs.
 *
 *  Each call returns a fresh processor since `unified()` instances
 *  carry mutable state when used concurrently. */
export function buildPlanParser() {
  return unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkFrontmatter, ["yaml"])
    .use(remarkMath);
}
