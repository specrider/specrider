import { useRef, useState } from "react";
import { ContextMenu, type ContextMenuItem } from "../components/ContextMenu";
import { Icon } from "../components/icons";
import { useWorkspaceTrust } from "./trust";

interface Props {
  /** Used in the tooltip so the shield identifies *which* workspace
   *  the decision applies to. */
  plansRoot: string | null;
}

function repoDecisionLabel(decision: "trusted" | "untrusted" | null): string {
  if (decision === "trusted") return "trusted";
  if (decision === "untrusted") return "untrusted";
  return "pending";
}

function pendingLinkedLabel(repos: { handle: string }[]): string {
  if (repos.length === 1) return repos[0].handle;
  return "linked folders";
}

/** Title-bar shield that surfaces the active workspace's trust state
 *  and lets the user flip it. Renders nothing when there's no plans
 *  root (the empty-state UI has nothing to gate). */
export function TrustShield({ plansRoot }: Props) {
  const trust = useWorkspaceTrust();
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const [menu, setMenu] = useState<{ left: number; top: number } | null>(null);

  if (!plansRoot) return null;
  if (trust.status === "loading") return null;

  const variant: "trusted" | "untrusted" | "ask" =
    trust.status === "trusted"
      ? "trusted"
      : trust.status === "untrusted"
        ? "untrusted"
        : "ask";

  const labels: Record<typeof variant, { tip: string; aria: string }> = {
    trusted: {
      tip: "Trusted workspace — remote images and previews load.\nClick to change.",
      aria: "Workspace trusted",
    },
    untrusted: {
      tip: "Untrusted workspace — remote content shows a placeholder.\nClick to change.",
      aria: "Workspace untrusted",
    },
    ask: {
      tip: "Trust decision pending.\nClick to choose.",
      aria: "Trust decision pending",
    },
  };

  const hasPendingLinkedRepos = trust.pendingLinkedRepos.length > 0;
  const hasLinkedRepos = trust.linkedRepos.length > 0;
  const needsRootDecision = trust.rootDecision === null;
  const pendingLinked = pendingLinkedLabel(trust.pendingLinkedRepos);
  const trustLabel = hasPendingLinkedRepos
    ? needsRootDecision
      ? `Trust workspace and ${pendingLinked}`
      : `Trust ${pendingLinked}`
    : "Trust this workspace";
  const untrustLabel = hasPendingLinkedRepos
    ? needsRootDecision
      ? `Don't trust workspace or ${pendingLinked}`
      : `Don't trust ${pendingLinked}`
    : "Don't trust this workspace";
  const trustOptions = {
    applyRoot: hasPendingLinkedRepos ? needsRootDecision : true,
    applyPendingLinkedRepos: hasPendingLinkedRepos,
  };
  const hasLinkedRepoDecision = trust.linkedRepos.some(
    (repo) => repo.decision !== null,
  );

  const toggleMenu = () => {
    if (menu) {
      setMenu(null);
      return;
    }
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    setMenu({ left: r.left, top: r.bottom + 4 });
  };

  const items: ContextMenuItem[] = [
    {
      label: trustLabel,
      disabled: variant === "trusted" && !hasPendingLinkedRepos,
      onSelect: () => {
        void trust.set("trusted", trustOptions);
      },
    },
    {
      label: untrustLabel,
      disabled: variant === "untrusted" && !hasPendingLinkedRepos,
      onSelect: () => {
        void trust.set("untrusted", trustOptions);
      },
    },
    ...(hasLinkedRepos
      ? [
          { divider: true, label: "" },
          { label: "Linked repos", disabled: true },
          ...trust.linkedRepos.map((repo) => ({
            label: `${repo.handle} · ${repoDecisionLabel(repo.decision)}`,
            disabled: true,
          })),
        ]
      : []),
    { divider: true, label: "" },
    {
      label: hasLinkedRepos ? "Forget workspace decision" : "Forget decision",
      // Clearing returns to "ask" — useful for testing the prompt or
      // re-evaluating after a remote update.
      disabled: trust.rootDecision === null,
      onSelect: () => {
        void trust.set(null, { applyRoot: true });
      },
    },
    ...(hasLinkedRepos
      ? [
          {
            label: "Forget linked folder decisions",
            disabled: !hasLinkedRepoDecision,
            onSelect: () => {
              void trust.set(null, {
                applyRoot: false,
                applyPendingLinkedRepos: true,
              });
            },
          },
        ]
      : []),
  ];

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`tb-btn trust-shield trust-shield-${variant}`}
        title={`${labels[variant].tip}\n${plansRoot}`}
        aria-label={labels[variant].aria}
        onClick={toggleMenu}
      >
        <Icon.Shield />
      </button>
      {menu && (
        <ContextMenu
          anchor={menu}
          items={items}
          onClose={() => setMenu(null)}
          triggerRef={btnRef}
        />
      )}
    </>
  );
}
