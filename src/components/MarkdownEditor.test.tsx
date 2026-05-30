import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MarkdownEditor, type MarkdownEditorHandle } from "./MarkdownEditor";

const settingsMocks = vi.hoisted(() => ({
  effective: {
    editorLineNumbers: true,
    editorSoftWrap: true,
    editorTabSize: 2,
  },
}));

vi.mock("../settings/store", () => ({
  useSettings: () => ({
    effective: settingsMocks.effective,
  }),
}));

describe("MarkdownEditor", () => {
  beforeEach(() => {
    settingsMocks.effective.editorLineNumbers = true;
    settingsMocks.effective.editorSoftWrap = true;
    settingsMocks.effective.editorTabSize = 2;
  });

  it("syncs external value changes into the editor handle", async () => {
    const ref = createRef<MarkdownEditorHandle>();
    const onChange = vi.fn();
    const { container, rerender } = render(
      <MarkdownEditor ref={ref} value="# One" onChange={onChange} />,
    );

    await waitFor(() => expect(ref.current?.totalLines()).toBe(1));
    const editorEl = container.querySelector(".cm-editor");

    rerender(
      <MarkdownEditor
        ref={ref}
        value={"# One\n\n- [ ] Follow up"}
        onChange={onChange}
      />,
    );

    await waitFor(() => expect(ref.current?.totalLines()).toBe(3));
    expect(container.querySelector(".cm-editor")).toBe(editorEl);
    act(() => {
      ref.current?.scrollToLine(3, { placeCursor: "afterTaskMarker" });
    });

    expect(ref.current?.currentLine()).toBe(3);
  });

  it("notifies viewport subscribers and supports unsubscribe", async () => {
    const ref = createRef<MarkdownEditorHandle>();
    const onViewport = vi.fn();
    const { container } = render(
      <MarkdownEditor
        ref={ref}
        value={"# One\n\nBody\n\nMore"}
        onChange={vi.fn()}
      />,
    );

    await waitFor(() => expect(ref.current).toBeTruthy());
    const unsubscribe = ref.current?.onViewportChange(onViewport);
    const scroller = container.querySelector(".cm-scroller") as HTMLElement;

    scroller.scrollTop = 12;
    fireEvent.scroll(scroller);

    await waitFor(() => expect(onViewport).toHaveBeenCalled());

    onViewport.mockClear();
    unsubscribe?.();
    scroller.scrollTop = 24;
    fireEvent.scroll(scroller);

    expect(onViewport).not.toHaveBeenCalled();
  });
});
