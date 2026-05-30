import { useCallback, useEffect, useMemo, useState } from "react";
import { useToasts } from "../hooks/useToasts";
import {
  getWorkspaceConfig,
  onWorkspaceConfigChanged,
  type WorkspaceConfigSnapshot,
  writeWorkspaceConfig,
} from "../tauri/api";

interface Props {
  plansRoot: string | null;
}

export function WorkspaceConfigPrompt({ plansRoot }: Props) {
  const [snapshot, setSnapshot] = useState<WorkspaceConfigSnapshot | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const { push: pushToast } = useToasts();

  const dismissKey = useMemo(
    () =>
      plansRoot ? `specrider.workspaceConfigPrompt.dismissed.${plansRoot}` : "",
    [plansRoot],
  );

  const refresh = useCallback(async () => {
    if (!plansRoot) {
      setSnapshot(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      setSnapshot(await getWorkspaceConfig(plansRoot));
    } catch (err) {
      console.error("getWorkspaceConfig failed:", err);
      setSnapshot(null);
    } finally {
      setLoading(false);
    }
  }, [plansRoot]);

  useEffect(() => {
    if (!plansRoot) {
      setDismissed(false);
      setSnapshot(null);
      return;
    }
    setDismissed(localStorage.getItem(dismissKey) === "1");
    void refresh();

    let cancelled = false;
    let unlisten: (() => void) | null = null;
    void onWorkspaceConfigChanged(() => {
      void refresh();
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [plansRoot, dismissKey, refresh]);

  if (!plansRoot || loading || dismissed || !snapshot || snapshot.exists) {
    return null;
  }

  const onDismiss = () => {
    localStorage.setItem(dismissKey, "1");
    setDismissed(true);
  };

  const onCreate = async () => {
    if (busy) return;
    setBusy(true);
    try {
      setSnapshot(await writeWorkspaceConfig("lightweight", plansRoot));
      pushToast("Workspace config created.", { tone: "success" });
    } catch (err) {
      pushToast(`Could not create workspace config: ${String(err)}`, {
        tone: "error",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="workspace-config-prompt" role="status">
      <div className="workspace-config-copy">
        <strong>Workspace config is optional.</strong>
        <span>
          Create <code>.specrider/workspace.json</code> to define statuses and
          linked repository handles for this workspace.
        </span>
      </div>
      <div className="workspace-config-prompt-actions">
        <button type="button" onClick={() => void onCreate()} disabled={busy}>
          {busy ? "Creating..." : "Create basic config"}
        </button>
        <button type="button" onClick={onDismiss} disabled={busy}>
          Not now
        </button>
      </div>
    </div>
  );
}
