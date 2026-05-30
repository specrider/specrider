import { useEffect, useRef } from "react";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { formatHomePath } from "../lib/pathDisplay";
import { useWorkspaceTrust } from "./trust";

interface Props {
  /** Active plans-root path. Shown in the prompt body so the user
   *  knows exactly which folder they're answering for. Will be
   *  tildeified for display when `homeDir` is provided. */
  plansRoot: string;
  homeDir: string;
}

/** First-open trust prompt. Renders only when the workspace-trust
 *  status is `"ask"` — i.e. no decision has been recorded for this
 *  plans-root and the global default policy is `alwaysAsk`.
 *
 *  Two buttons; no in-prompt bypass. A "default to trust everything"
 *  toggle right next to the Trust button defeats the protection one
 *  impatient click at a time. Power users who want auto-trust opt in
 *  deliberately from Settings → Trust & Access; the prompt itself is purely
 *  a per-workspace decision.
 *
 *  Escape is intentionally a no-op — there is no neutral state for
 *  the question. The user must pick before remote content can render. */
export function TrustPrompt({ plansRoot, homeDir }: Props) {
  const trust = useWorkspaceTrust();
  const ref = useRef<HTMLDivElement | null>(null);
  useFocusTrap(ref);

  // Block scroll behind the modal so users can't interact with the
  // app while the prompt is up.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  const onTrust = () => {
    void trust.set("trusted", {
      applyRoot: trust.rootDecision === null,
      applyPendingLinkedRepos: trust.pendingLinkedRepos.length > 0,
    });
  };

  const onDoNotTrust = () => {
    void trust.set("untrusted", {
      applyRoot: trust.rootDecision === null,
      applyPendingLinkedRepos: trust.pendingLinkedRepos.length > 0,
    });
  };

  const display = formatHomePath(plansRoot, homeDir);
  const pendingLinkedRepos = trust.pendingLinkedRepos;
  const needsRootDecision = trust.rootDecision === null;
  const hasLinkedRepos = pendingLinkedRepos.length > 0;
  const title = hasLinkedRepos
    ? needsRootDecision
      ? "Trust this workspace and linked folders?"
      : "Trust linked repositories?"
    : "Do you trust this workspace?";
  const primaryLabel = hasLinkedRepos
    ? needsRootDecision
      ? "Trust workspace and folders"
      : "Trust linked folders"
    : "Trust this workspace";
  const secondaryLabel = hasLinkedRepos
    ? needsRootDecision
      ? "Don't trust"
      : "Don't trust linked folders"
    : "Don't trust";

  return (
    <div className="modal-backdrop trust-prompt-backdrop">
      <div
        className="trust-prompt"
        role="dialog"
        aria-modal="true"
        aria-labelledby="trust-prompt-title"
        ref={ref}
      >
        <h2 id="trust-prompt-title" className="trust-prompt-title">
          {title}
        </h2>
        {needsRootDecision && (
          <div className="trust-prompt-path" title={plansRoot}>
            {display}
          </div>
        )}
        {hasLinkedRepos && (
          <ul className="trust-prompt-linked-list">
            {pendingLinkedRepos.map((repo) => (
              <li
                key={`${repo.handle}:${repo.path}`}
                className="trust-prompt-linked-item"
                title={repo.path}
              >
                <span className="trust-prompt-linked-handle">
                  {repo.handle}
                </span>
                <span className="trust-prompt-linked-path">
                  {formatHomePath(repo.path, homeDir)}
                </span>
              </li>
            ))}
          </ul>
        )}
        {needsRootDecision && (
          <p className="trust-prompt-body">
            Trusted plans can load images and previews from the internet.
            Untrusted plans show a placeholder for remote content until you
            click it.
          </p>
        )}
        {hasLinkedRepos && (
          <p className="trust-prompt-body">
            Linked repositories are used for read-only Git diff access.
            SpecRider refuses mutating Git commands for these folders.
          </p>
        )}
        <div className="trust-prompt-actions">
          <button
            type="button"
            className="trust-prompt-btn secondary"
            onClick={onDoNotTrust}
          >
            {secondaryLabel}
          </button>
          <button
            type="button"
            className="trust-prompt-btn primary"
            onClick={onTrust}
          >
            {primaryLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

interface HostProps {
  plansRoot: string | null;
  homeDir: string;
}

/** Mounts `<TrustPrompt>` only when the active workspace has no
 *  recorded trust decision and the global default is "always ask".
 *  Lives inside `<WorkspaceTrustProvider>` so it can read the hook. */
export function TrustPromptHost({ plansRoot, homeDir }: HostProps) {
  const trust = useWorkspaceTrust();
  if (!plansRoot) return null;
  if (trust.status !== "ask") return null;
  return <TrustPrompt plansRoot={plansRoot} homeDir={homeDir} />;
}
