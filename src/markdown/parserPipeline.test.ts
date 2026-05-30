import type { Root } from "mdast";
import { describe, expect, it } from "vitest";
import { buildPlanParser } from "./parserPipeline";

const fixtures: { name: string; src: string }[] = [
  { name: "plain prose", src: "Hello world." },
  { name: "heading + paragraph", src: "# Title\n\nIntro." },
  { name: "list", src: "- one\n- two\n  - nested\n" },
  { name: "task list", src: "- [ ] todo\n- [x] done\n" },
  { name: "fenced code", src: "```ts\nconst x = 1;\n```\n" },
  { name: "mermaid fence", src: "```mermaid\ngraph TD;\nA-->B;\n```\n" },
  { name: "math fence", src: "```math\nx + y\n```\n" },
  { name: "inline math", src: "Inline $E = mc^2$ here." },
  { name: "display math", src: "$$\n\\int x \\,dx\n$$\n" },
  { name: "footnotes", src: "Claim.[^a]\n\n[^a]: Note.\n" },
  { name: "table", src: "| a | b |\n|---|---|\n| 1 | 2 |\n" },
  { name: "frontmatter", src: "---\nstatus: draft\n---\n# Hi\n" },
  { name: "blockquote", src: "> a quote\n>\n> with two paragraphs\n" },
  { name: "callout", src: "> [!NOTE]\n> watch out\n" },
  { name: "thematic break", src: "before\n\n---\n\nafter\n" },
];

/** Strip `position` so two parses with different line-counters
 *  (e.g. trailing newlines) still compare equal. We're verifying
 *  that the parser pipeline is deterministic, not the source map. */
function stripPositions(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripPositions);
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === "position") continue;
      out[k] = stripPositions(v);
    }
    return out;
  }
  return node;
}

describe("buildPlanParser", () => {
  it("returns a fresh processor each call", () => {
    expect(buildPlanParser()).not.toBe(buildPlanParser());
  });

  it.each(fixtures)("parses $name deterministically", ({ src }) => {
    const a = buildPlanParser().parse(src) as Root;
    const b = buildPlanParser().parse(src) as Root;
    expect(stripPositions(a)).toEqual(stripPositions(b));
  });

  it("emits inlineMath nodes (math plugin is in the pipeline)", () => {
    const tree = buildPlanParser().parse("Hi $x$ there") as Root;
    const json = JSON.stringify(tree);
    expect(json).toContain("inlineMath");
  });

  it("emits footnoteDefinition nodes (gfm plugin is in the pipeline)", () => {
    const tree = buildPlanParser().parse("Claim[^a]\n\n[^a]: note\n") as Root;
    const types = tree.children.map((c) => c.type);
    expect(types).toContain("footnoteDefinition");
  });

  it("emits yaml nodes (frontmatter plugin is in the pipeline)", () => {
    const tree = buildPlanParser().parse(
      "---\nstatus: draft\n---\n# Hi\n",
    ) as Root;
    expect(tree.children[0].type).toBe("yaml");
  });
});
