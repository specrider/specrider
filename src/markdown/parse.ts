import yaml from "js-yaml";
import type { Root } from "mdast";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkStringify from "remark-stringify";
import { unified } from "unified";
import { buildPlanParser } from "./parserPipeline";

const parser = buildPlanParser();

const stringifier = unified()
  .use(remarkStringify, {
    bullet: "-",
    listItemIndent: "one",
    rule: "-",
  })
  .use(remarkGfm)
  .use(remarkFrontmatter, ["yaml"])
  .use(remarkMath);

export function parseMarkdown(source: string): Root {
  return parser.parse(source) as Root;
}

export function stringifyMarkdown(root: Root): string {
  return stringifier.stringify(root) as string;
}

export interface ParsedFrontmatter {
  status?: string;
  owner?: string;
  iteration?: number;
  last_review?: string;
  tags?: string[];
  title?: string;
  contributors?: string[];
  [key: string]: unknown;
}

export function extractFrontmatter(root: Root): ParsedFrontmatter | null {
  const first = root.children[0];
  if (first?.type !== "yaml") return null;
  try {
    const parsed = yaml.load(first.value) as ParsedFrontmatter;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (e) {
    console.warn("Malformed frontmatter:", e);
    return null;
  }
}
