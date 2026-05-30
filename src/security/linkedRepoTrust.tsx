import { useState } from "react";
import { useWorkspaceTrust } from "./trust";

const LINKED_REPO_TRUST_ERROR =
  /linked repo `[^`]+` (?:has not been trusted|is not trusted) for /i;

export function isLinkedRepoTrustError(error: string | null | undefined) {
  return !!error && LINKED_REPO_TRUST_ERROR.test(error);
}

interface Props {
  error: string;
  onTrusted?: () => void;
}

export function LinkedRepoTrustCallout({ error, onTrusted }: Props) {
  if (!isLinkedRepoTrustError(error)) return <>{error}</>;
  return <LinkedRepoTrustAction error={error} onTrusted={onTrusted} />;
}

function LinkedRepoTrustAction({ error, onTrusted }: Props) {
  const trust = useWorkspaceTrust();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const linkedCount = trust.pendingLinkedRepos.length;
  const label =
    linkedCount === 1
      ? `Trust ${trust.pendingLinkedRepos[0].handle}`
      : "Trust linked folders";

  const onTrust = async () => {
    setBusy(true);
    setActionError(null);
    try {
      await trust.set("trusted", {
        applyRoot: trust.rootDecision === null,
        // Ask Rust to trust the current linked repo candidates, even
        // if this renderer missed the pending-list refresh that led to
        // the read error being displayed here.
        applyPendingLinkedRepos: true,
      });
      onTrusted?.();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="linked-repo-trust-callout">
      <div className="linked-repo-trust-message">{error}</div>
      <button
        type="button"
        className="linked-repo-trust-btn"
        disabled={busy}
        onClick={onTrust}
      >
        {busy ? "Trusting..." : label}
      </button>
      {actionError && (
        <div className="linked-repo-trust-action-error">{actionError}</div>
      )}
    </div>
  );
}
