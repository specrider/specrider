// CommitHistoryPane — outline-rail surface when actionMode === "diff".
//
// Wraps CommitHistoryRail in the same `.pane.outline` shell the
// regular OutlinePane uses. App.tsx swaps between this and OutlinePane
// based on the right-rail mode tab.

import type { CommitDerived } from "../hooks/useCommitGraph";
import type { GraphLayout } from "../lib/commitGraphLanes";
import type { DiffReviewTab } from "../review/diffTabs";
import type { ResolvedSettings } from "../settings/types";
import type { GraphCommit, PlanRelevance, RefEntry } from "../tauri/api";
import { CommitHistoryRail, type CommitSelection } from "./CommitHistoryRail";

interface Props {
  commits: GraphCommit[];
  layout: GraphLayout;
  derivedBySha: Map<string, CommitDerived>;
  relevanceBySha: Map<string, PlanRelevance>;
  refsByCommit: Map<string, RefEntry[]>;
  displayRefsByCommit: Map<string, RefEntry[]>;
  loading: boolean;
  loaded: boolean;
  error: string | null;
  hasUnstaged: boolean;
  selected: CommitSelection | null;
  onSelect: (sel: CommitSelection) => void;
  onRefresh: () => void;
  readOnly?: boolean;
  repoHandle?: string | null;
  reviewBranch?: string | null;
  showLanes: boolean;
  settings: ResolvedSettings;
  tabs?: DiffReviewTab[];
  activeTabId?: string;
  onSelectTab?: (tabId: string) => void;
}

export function CommitHistoryPane(props: Props) {
  return (
    <div className="pane outline outline-mode-commits">
      <CommitHistoryRail {...props} />
    </div>
  );
}
