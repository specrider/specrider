import { fireEvent, render, screen } from "@testing-library/react";
import type { MutableRefObject } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Hunk } from "../tauri/api";
import { parseMarkdown } from "./parse";
import { MarkdownRender, renderFrontmatterValue } from "./render";

const trustSet = vi.hoisted(() => vi.fn());

vi.mock("../security/trust", () => ({
  useWorkspaceTrust: () => ({
    status: "ask",
    resolved: true,
    set: trustSet,
  }),
}));

function renderMarkdown(
  source: string,
  props: Partial<Parameters<typeof MarkdownRender>[0]> = {},
) {
  const headingRefs: MutableRefObject<Record<string, HTMLElement | null>> = {
    current: {},
  };
  return render(
    <MarkdownRender
      root={parseMarkdown(source)}
      headingRefs={headingRefs}
      toggleTask={vi.fn()}
      onLinkClick={vi.fn()}
      {...props}
    />,
  );
}

describe("MarkdownRender", () => {
  it("renders core document structure and routes safe link clicks", () => {
    const onLinkClick = vi.fn();
    const headingRefs: MutableRefObject<Record<string, HTMLElement | null>> = {
      current: {},
    };

    renderMarkdown("# Title\n\nRead the [guide](./guide.md).\n", {
      headingRefs,
      onLinkClick,
    });

    const heading = screen.getByRole("heading", { name: "Title" });
    expect(heading.id).toBe("title");
    expect(heading.dataset.sourceStartLine).toBe("1");
    expect(headingRefs.current.title).toBe(heading);

    fireEvent.click(screen.getByRole("link", { name: "guide" }));

    expect(onLinkClick).toHaveBeenCalledWith("./guide.md");
  });

  it("sanitizes raw HTML before inserting it into the document", () => {
    const { container } = renderMarkdown(
      '<span onclick="evil()">Safe</span><script>alert(1)</script>',
    );

    expect(screen.getByText("Safe")).toBeTruthy();
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("[onclick]")).toBeNull();
  });

  it("blocks remote images until the user opts into loading that image", () => {
    renderMarkdown("![Architecture](https://example.com/diagram.png)", {
      remoteAllowed: false,
    });

    const placeholder = screen.getByRole("button", {
      name: "Load external image (Architecture)",
    });
    expect(placeholder.textContent).toContain("click to load");

    fireEvent.click(placeholder);

    const image = screen.getByRole("img", { name: "Architecture" });
    expect(image.getAttribute("src")).toBe("https://example.com/diagram.png");
    expect(image.getAttribute("referrerpolicy")).toBe("no-referrer");
  });

  it("invokes task toggles with source line numbers", () => {
    const toggleTask = vi.fn();
    renderMarkdown("- [ ] write tests\n", { toggleTask });

    fireEvent.click(screen.getByRole("button", { name: "Check" }));

    expect(toggleTask).toHaveBeenCalledWith(1, true);
  });

  it("routes changed block clicks to the overlapping hunk", () => {
    const hunk: Hunk = {
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 1,
      before: "old\n",
      after: "new\n",
    };
    const onHunkClick = vi.fn();
    renderMarkdown("Changed paragraph\n", {
      diff: {
        added: [],
        modified: [1],
        deletedAfter: [],
        hunks: [hunk],
      },
      onHunkClick,
    });

    fireEvent.click(screen.getByText("Changed paragraph"));

    expect(onHunkClick).toHaveBeenCalledWith(hunk);
  });

  it("renders footnote references and definitions in reference order", () => {
    renderMarkdown(
      "Alpha[^b] and beta[^a].\n\n[^a]: First definition\n[^b]: Second definition\n",
    );

    expect(screen.getByRole("link", { name: "[1]" }).getAttribute("href")).toBe(
      "#fn-b",
    );
    expect(screen.getByRole("link", { name: "[2]" }).getAttribute("href")).toBe(
      "#fn-a",
    );
    expect(screen.getByText("Second definition")).toBeTruthy();
    expect(screen.getByText("First definition")).toBeTruthy();
    expect(
      screen.getAllByRole("link", { name: "Return to reference" }),
    ).toHaveLength(2);
  });

  it("renders tables with sortable headers and an expandable viewer", () => {
    renderMarkdown(
      "| Item | Qty |\n| --- | ---: |\n| Beta | 2 |\n| Alpha | 1 |\n",
    );

    expect(screen.getByRole("table")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Qty/ }));

    const rows = screen.getAllByRole("row");
    expect(rows[1].textContent).toContain("Alpha");
    expect(rows[2].textContent).toContain("Beta");

    fireEvent.click(
      screen.getByRole("button", { name: "Open table in viewer" }),
    );

    expect(screen.getByRole("dialog", { name: "Table viewer" })).toBeTruthy();
    expect(screen.getAllByRole("table")).toHaveLength(2);
  });
});

describe("renderFrontmatterValue", () => {
  it("renders linked repo frontmatter as readable review targets", () => {
    const html = renderToStaticMarkup(
      renderFrontmatterValue("links", [
        { repo: "code", branch: "linked-code", base: "main" },
      ]),
    );

    expect(html).toContain("fm-link");
    expect(html).toContain("code");
    expect(html).toContain("linked-code");
    expect(html).toContain("base: main");
    expect(html).not.toContain("base main");
    expect(html).not.toContain("[object Object]");
  });

  it("renders valid linked repo frontmatter as buttons when a click handler is supplied", () => {
    const html = renderToStaticMarkup(
      renderFrontmatterValue(
        "links",
        [{ repo: "code", branch: "linked-code", base: "main" }],
        { onLinkClick: () => undefined },
      ),
    );

    expect(html).toContain("<button");
    expect(html).toContain("fm-link-button");
  });

  it("renders object arrays as key/value summaries", () => {
    const html = renderToStaticMarkup(
      renderFrontmatterValue("reviewers", [{ name: "jake" }]),
    );

    expect(html).toContain("name: jake");
    expect(html).not.toContain("[object Object]");
  });

  it("keeps parsed YAML dates readable", () => {
    const html = renderToStaticMarkup(
      renderFrontmatterValue("reviewed", new Date("2026-05-14")),
    );

    expect(html).toBe("2026-05-14");
  });
});
