import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { FileChange } from "../tauri/api";
import { CommitFileList } from "./CommitFileList";

const file: FileChange = {
  status: "modified",
  path: "src/components/example.tsx",
  oldPath: null,
  additions: 8,
  deletions: 2,
  hunks: [],
  binary: false,
  truncatedLines: null,
  large: false,
};

function renderList({
  selectedPath = null,
}: {
  selectedPath?: string | null;
} = {}) {
  const onSelect = vi.fn();
  const onClearSelection = vi.fn();
  const rootEl = document.createElement("div");
  document.body.appendChild(rootEl);
  const root = createRoot(rootEl);

  act(() => {
    root.render(
      <CommitFileList
        files={[file]}
        selectedPath={selectedPath}
        onSelect={onSelect}
        onClearSelection={onClearSelection}
      />,
    );
  });

  const button = rootEl.querySelector<HTMLButtonElement>(".cfl-row-button");
  if (!button) throw new Error("expected file row button");
  return { root, rootEl, button, onSelect, onClearSelection };
}

describe("CommitFileList", () => {
  const roots: Root[] = [];
  const rootEls: HTMLElement[] = [];

  beforeAll(() => {
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    roots.length = 0;
    rootEls.length = 0;
  });

  afterEach(() => {
    for (const root of roots) {
      act(() => root.unmount());
    }
    for (const rootEl of rootEls) {
      rootEl.remove();
    }
  });

  it("selects a file on single click", () => {
    const view = renderList();
    roots.push(view.root);
    rootEls.push(view.rootEl);

    view.button.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(view.onSelect).toHaveBeenCalledWith(file.path);
  });

  it("shows the scoped-file banner and clears it from the clear button", () => {
    const view = renderList({ selectedPath: file.path });
    roots.push(view.root);
    rootEls.push(view.rootEl);

    const clear =
      view.rootEl.querySelector<HTMLButtonElement>(".cfl-filter-clear");
    if (!clear) throw new Error("expected clear button");
    clear.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(view.rootEl.querySelector(".cfl-filter-banner")).toBeTruthy();
    expect(view.onClearSelection).toHaveBeenCalledTimes(1);
  });
});
