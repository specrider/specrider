// Git surfaces that need access to the GitStatusProvider context.
// As of the diff-pane redesign this only houses the conflict banner;
// commit work itself lives inside the diff explorer pane.

import { useGitStatusContext } from "../hooks/gitStatusContext";
import { ConflictBanner } from "./ConflictBanner";

interface Props {
  onOpenPlan?: (rel: string) => void;
}

export function GitOverlays({ onOpenPlan }: Props) {
  const { status, refresh } = useGitStatusContext();
  if (!status) return null;
  return (
    <ConflictBanner
      status={status}
      onChanged={refresh}
      onOpenPlan={onOpenPlan}
    />
  );
}
