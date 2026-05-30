import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceConfigSnapshot } from "../tauri/api";
import { WorkspaceConfigPrompt } from "./WorkspaceConfigPrompt";

const apiMocks = vi.hoisted(() => ({
  getWorkspaceConfig: vi.fn(),
  onWorkspaceConfigChanged: vi.fn(),
  writeWorkspaceConfig: vi.fn(),
}));

const toastMocks = vi.hoisted(() => ({
  push: vi.fn(),
}));

vi.mock("../tauri/api", () => ({
  getWorkspaceConfig: apiMocks.getWorkspaceConfig,
  onWorkspaceConfigChanged: apiMocks.onWorkspaceConfigChanged,
  writeWorkspaceConfig: apiMocks.writeWorkspaceConfig,
}));

vi.mock("../hooks/useToasts", () => ({
  useToasts: () => ({ push: toastMocks.push }),
}));

function workspaceConfigSnapshot(exists: boolean): WorkspaceConfigSnapshot {
  return {
    exists,
    path: "/plans/.specrider/workspace.json",
    source: exists ? "file" : "default",
    config: {
      schema_version: "1",
      statuses: [],
      review_required_signoffs: 0,
      default_status: "draft",
      repos: {},
    },
  };
}

describe("WorkspaceConfigPrompt", () => {
  beforeEach(() => {
    localStorage.clear();
    for (const mock of Object.values(apiMocks)) mock.mockReset();
    toastMocks.push.mockReset();
    apiMocks.getWorkspaceConfig.mockResolvedValue(
      workspaceConfigSnapshot(false),
    );
    apiMocks.writeWorkspaceConfig.mockResolvedValue(
      workspaceConfigSnapshot(true),
    );
    apiMocks.onWorkspaceConfigChanged.mockResolvedValue(vi.fn());
  });

  it("creates a lightweight workspace config from the prompt", async () => {
    const user = userEvent.setup();

    render(<WorkspaceConfigPrompt plansRoot="/plans" />);

    expect(
      await screen.findByText("Workspace config is optional."),
    ).toBeTruthy();
    await user.click(
      screen.getByRole("button", { name: "Create basic config" }),
    );

    expect(apiMocks.writeWorkspaceConfig).toHaveBeenCalledWith(
      "lightweight",
      "/plans",
    );
    expect(toastMocks.push).toHaveBeenCalledWith("Workspace config created.", {
      tone: "success",
    });
    await waitFor(() =>
      expect(screen.queryByText("Workspace config is optional.")).toBeNull(),
    );
  });

  it("dismisses the prompt per workspace", async () => {
    const user = userEvent.setup();

    render(<WorkspaceConfigPrompt plansRoot="/plans" />);

    await user.click(await screen.findByRole("button", { name: "Not now" }));

    expect(
      localStorage.getItem("specrider.workspaceConfigPrompt.dismissed./plans"),
    ).toBe("1");
    expect(screen.queryByText("Workspace config is optional.")).toBeNull();
  });
});
