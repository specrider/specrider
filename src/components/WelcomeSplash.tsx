import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  listRecentProjects,
  type RecentProject,
  setPlansRoot,
} from "../tauri/api";

interface Props {
  onChooseFolder: () => void;
  onChooseFile: () => void;
}

const MAX_WELCOME_RECENTS = 9;

/** Empty-workspace splash. Two newspaper-style index sections separated
 *  by hairline rules, with number keys mapped to the visible recent
 *  projects. */
export function WelcomeSplash({ onChooseFolder, onChooseFile }: Props) {
  const [recents, setRecents] = useState<RecentProject[]>([]);
  const visibleRecents = useMemo(
    () => recents.slice(0, MAX_WELCOME_RECENTS),
    [recents],
  );
  const visibleRecentsRef = useRef<RecentProject[]>([]);

  useLayoutEffect(() => {
    visibleRecentsRef.current = visibleRecents;
  }, [visibleRecents]);

  useEffect(() => {
    let cancelled = false;
    listRecentProjects()
      .then((list) => {
        if (!cancelled) setRecents(list);
      })
      .catch((e) => console.error("listRecentProjects:", e));
    return () => {
      cancelled = true;
    };
  }, []);

  const onOpenRecent = useCallback((path: string) => {
    setPlansRoot(path).catch((e) => console.error("setPlansRoot:", e));
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey) return;
      if (event.altKey || event.shiftKey) return;
      if (!/^[1-9]$/.test(event.key)) return;

      const recent =
        visibleRecentsRef.current[Number.parseInt(event.key, 10) - 1];
      if (!recent) return;
      event.preventDefault();
      onOpenRecent(recent.path);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onOpenRecent]);

  return (
    <div className="app empty">
      <div className="empty-drag" data-tauri-drag-region />
      <div className="welcome">
        {/* Two index sections — actions on top, history below.
            Section heads put the label on the *right* (small mono)
            with the rule sweeping in from the left, which inverts the
            usual web pattern enough to feel intentional. */}
        <section className="welcome-section">
          <header className="welcome-section-head">
            <span className="welcome-section-rule" />
            <span className="welcome-section-label">Begin</span>
          </header>
          <ul className="welcome-list">
            <li>
              <button
                type="button"
                className="welcome-row"
                onClick={onChooseFolder}
              >
                <span className="welcome-row-arrow" aria-hidden="true">
                  →
                </span>
                <span className="welcome-row-label">Open a folder</span>
                <span className="welcome-row-leader" aria-hidden="true" />
                <span className="welcome-row-kbd">
                  <kbd>⌘</kbd>
                  <kbd>O</kbd>
                </span>
              </button>
            </li>
            <li>
              <button
                type="button"
                className="welcome-row"
                onClick={onChooseFile}
              >
                <span className="welcome-row-arrow" aria-hidden="true">
                  →
                </span>
                <span className="welcome-row-label">Open a single file</span>
                <span className="welcome-row-leader" aria-hidden="true" />
                <span className="welcome-row-kbd">
                  <kbd>⌘</kbd>
                  <kbd>⌥</kbd>
                  <kbd>O</kbd>
                </span>
              </button>
            </li>
          </ul>
        </section>

        {visibleRecents.length > 0 && (
          <section className="welcome-section">
            <header className="welcome-section-head">
              <span className="welcome-section-rule" />
              <span className="welcome-section-label">Previously</span>
            </header>
            <ol className="welcome-list welcome-list-numbered">
              {visibleRecents.map((r, i) => (
                <li key={r.path}>
                  <button
                    type="button"
                    className="welcome-row"
                    onClick={() => onOpenRecent(r.path)}
                    title={r.path}
                    aria-keyshortcuts={String(i + 1)}
                  >
                    <span className="welcome-row-shortcut" aria-hidden="true">
                      {i + 1}
                    </span>
                    <span className="welcome-row-label">{r.name}</span>
                    <span className="welcome-row-leader" aria-hidden="true" />
                    <span className="welcome-row-meta">{r.displayPath}</span>
                  </button>
                </li>
              ))}
            </ol>
          </section>
        )}
      </div>
    </div>
  );
}
