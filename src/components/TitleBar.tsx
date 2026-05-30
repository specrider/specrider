import { useGitStatusContext } from "../hooks/gitStatusContext";
import { formatHomePath } from "../lib/pathDisplay";
import { isVersionDismissed, useUpdaterState } from "../lib/updater";
import { TrustShield } from "../security/TrustShield";
import type { ResolvedSettings } from "../settings/types";
import { GitCluster } from "./GitCluster";
import { Icon } from "./icons";

interface Props {
  plansRoot: string | null;
  homeDir: string;
  settings: ResolvedSettings;
  browserVisible: boolean;
  outlineVisible: boolean;
  markdownOpen: boolean;
  terminalOpen: boolean;
  diffOpen: boolean;
  onToggleBrowser: () => void;
  onOpenSearch: () => void;
  onToggleOutline: () => void;
  onToggleMarkdown: () => void;
  onToggleTerminal: () => void;
  onToggleDiff: () => void;
  onOpenUncommitted: () => void;
  onOpenUpdate: () => void;
}

export function TitleBar({
  plansRoot,
  homeDir,
  settings,
  browserVisible,
  outlineVisible,
  markdownOpen,
  terminalOpen,
  diffOpen,
  onToggleBrowser,
  onOpenSearch,
  onToggleOutline,
  onToggleMarkdown,
  onToggleTerminal,
  onToggleDiff,
  onOpenUncommitted,
  onOpenUpdate,
}: Props) {
  const display = plansRoot ? formatHomePath(plansRoot, homeDir) : "";
  const { status: gitStatus } = useGitStatusContext();
  const showBranchCluster =
    settings.gitShowStatusCluster && !!gitStatus?.inRepo;

  // Update-available chip. Visible whenever the updater reports a
  // pending version the user hasn't explicitly skipped. Mid-download
  // and mid-install state also surface here so the user has a way
  // back into the modal after dismissing it.
  const updater = useUpdaterState();
  const updateVisible =
    updater.update !== null &&
    (updater.status === "available" ||
      updater.status === "downloading" ||
      updater.status === "installing" ||
      updater.status === "restart-pending") &&
    !isVersionDismissed(updater.update.version);
  const updateLabel =
    updater.status === "restart-pending"
      ? "Restart to update"
      : updater.status === "downloading" || updater.status === "installing"
        ? "Update in progress…"
        : `Update to v${updater.update?.version ?? ""}`;

  return (
    <header className="titlebar" data-tauri-drag-region>
      <div
        className="tb-traffic-spacer"
        data-tauri-drag-region
        aria-hidden="true"
      />
      <div className="tb-cluster" data-tauri-drag-region>
        {display && (
          <span
            className="tb-path-display"
            data-tauri-drag-region
            title={plansRoot ?? ""}
          >
            {display}
          </span>
        )}
        <TrustShield plansRoot={plansRoot} />
        {showBranchCluster && (
          <GitCluster
            settings={settings}
            onOpenUncommitted={onOpenUncommitted}
          />
        )}
      </div>
      <div className="tb-spacer" data-tauri-drag-region />
      {updateVisible && (
        <button
          type="button"
          className={`tb-update-chip ${updater.status}`}
          onClick={onOpenUpdate}
          title={updateLabel}
        >
          <span className="tb-update-chip-dot" aria-hidden="true" />
          <span className="tb-update-chip-label">{updateLabel}</span>
        </button>
      )}
      <div className="tb-actions">
        <button
          type="button"
          className="tb-btn"
          title="Search across documents"
          aria-label="Search across documents"
          onClick={onOpenSearch}
        >
          <Icon.Search2 />
        </button>
        <button
          type="button"
          className={`tb-btn ${browserVisible ? "on" : ""}`}
          title="Toggle browser"
          aria-label="Toggle browser"
          aria-pressed={browserVisible}
          onClick={onToggleBrowser}
        >
          <Icon.Sidebar />
        </button>
        <button
          type="button"
          className={`tb-btn ${markdownOpen ? "on" : ""}`}
          title="Toggle Markdown pane"
          aria-label="Toggle Markdown pane"
          aria-pressed={markdownOpen}
          onClick={onToggleMarkdown}
        >
          <Icon.Markdown />
        </button>
        <button
          type="button"
          className={`tb-btn ${terminalOpen ? "on" : ""}`}
          title="Toggle agent terminal (⌃`)"
          aria-label="Toggle agent terminal"
          aria-pressed={terminalOpen}
          onClick={onToggleTerminal}
        >
          <Icon.Terminal />
        </button>
        <button
          type="button"
          className={`tb-btn ${diffOpen ? "on" : ""}`}
          title="Toggle diff explorer (⌃⇧`)"
          aria-label="Toggle diff explorer"
          aria-pressed={diffOpen}
          onClick={onToggleDiff}
        >
          <Icon.Branch />
        </button>
        <button
          type="button"
          className={`tb-btn ${outlineVisible ? "on" : ""}`}
          title="Toggle outline"
          aria-label="Toggle outline"
          aria-pressed={outlineVisible}
          onClick={onToggleOutline}
        >
          <Icon.Outline />
        </button>
      </div>
    </header>
  );
}
