import { openUrl } from "@tauri-apps/plugin-opener";
import { useCallback, useEffect, useRef } from "react";
import { useFocusTrap } from "../hooks/useFocusTrap";
import {
  abandonDownload,
  discardPendingUpdate,
  dismissVersion,
  installUpdate,
  relaunchApp,
  releaseNotesUrl,
  type UpdaterState,
} from "../lib/updater";

interface Props {
  state: UpdaterState;
  onClose: () => void;
}

/** Modal shown when the updater finds a new version. Pure UI — the
 *  state machine and side effects live in `src/lib/updater.ts`; this
 *  component just reads the current status and renders the matching
 *  surface (Install / progress / restart). */
export function UpdateAvailable({ state, onClose }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  useFocusTrap(ref);
  const downloading = state.status === "downloading";

  const handleClose = useCallback(() => {
    if (downloading) {
      // Tell the install flow to drop the bytes when the download
      // finishes — the underlying request can't be aborted mid-flight.
      abandonDownload();
    }
    onClose();
  }, [downloading, onClose]);

  // Block scroll behind the modal so users don't accidentally interact
  // with the app while a download is running.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // Esc closes the modal (and abandons in-flight downloads).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        handleClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleClose]);

  if (!state.update) {
    // Guard: parent shouldn't render UpdateAvailable when there's no
    // pending update info, but stay safe in case of a race.
    return null;
  }

  const { version, currentVersion, body } = state.update;
  const status = state.status;

  const installing = status === "installing";
  const installed = status === "restart-pending";
  const failed = status === "error";

  const handleInstall = () => {
    void installUpdate();
  };

  const handleLater = () => {
    void discardPendingUpdate();
    onClose();
  };

  const handleDismissThisVersion = () => {
    dismissVersion(version);
    void discardPendingUpdate();
    onClose();
  };

  const handleRestart = () => {
    void relaunchApp();
  };

  const handleOpenNotes = () => {
    openUrl(releaseNotesUrl(version)).catch((e) => {
      console.error("[updater] open release notes failed:", e);
    });
  };

  const progressPercent =
    state.totalBytes && state.totalBytes > 0
      ? Math.min(
          100,
          Math.round((state.downloadedBytes / state.totalBytes) * 100),
        )
      : null;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click dismisses the modal; focus is trapped inside the dialog.
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape key handling is registered at window level above.
    <div className="modal-backdrop update-modal-backdrop" onClick={handleClose}>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: this click only prevents backdrop dismissal. */}
      <div
        ref={ref}
        className="update-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="update-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="update-modal-title" className="update-modal-title">
          {installed
            ? "Update installed"
            : installing
              ? "Installing…"
              : downloading
                ? "Downloading update…"
                : failed
                  ? "Update failed"
                  : "Update available"}
        </h2>

        <div className="update-modal-versions">
          <span className="update-modal-version-from">v{currentVersion}</span>
          <span className="update-modal-version-arrow" aria-hidden="true">
            →
          </span>
          <span className="update-modal-version-to">v{version}</span>
        </div>

        {body && (
          <div className="update-modal-notes">
            <p className="update-modal-notes-body">{body}</p>
          </div>
        )}

        <button
          type="button"
          className="update-modal-link"
          onClick={handleOpenNotes}
        >
          View full release notes on GitHub ↗
        </button>

        {downloading && (
          <div className="update-modal-progress">
            <div
              className="update-modal-progress-bar"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={state.totalBytes ?? undefined}
              aria-valuenow={state.downloadedBytes}
              aria-valuetext={
                progressPercent !== null
                  ? `${progressPercent}% downloaded`
                  : `${formatBytes(state.downloadedBytes)} downloaded`
              }
            >
              <div
                className="update-modal-progress-fill"
                style={{
                  width:
                    progressPercent !== null ? `${progressPercent}%` : "50%",
                }}
              />
            </div>
            <div className="update-modal-progress-label">
              {progressPercent !== null
                ? `${progressPercent}% · ${formatBytes(state.downloadedBytes)} of ${formatBytes(state.totalBytes ?? 0)}`
                : `${formatBytes(state.downloadedBytes)} downloaded`}
            </div>
          </div>
        )}

        {failed && state.error && (
          <div className="update-modal-error">{state.error}</div>
        )}

        <div className="update-modal-actions">
          {installed ? (
            <>
              <button
                type="button"
                className="update-modal-btn secondary"
                onClick={handleClose}
              >
                Restart later
              </button>
              <button
                type="button"
                className="update-modal-btn primary"
                onClick={handleRestart}
              >
                Restart now
              </button>
            </>
          ) : downloading || installing ? (
            <button
              type="button"
              className="update-modal-btn secondary"
              onClick={handleClose}
              disabled={installing}
              title={
                installing
                  ? "Install can't be cancelled — it's almost done"
                  : "Cancel and close"
              }
            >
              {installing ? "Installing…" : "Cancel"}
            </button>
          ) : failed ? (
            <>
              <button
                type="button"
                className="update-modal-btn secondary"
                onClick={handleClose}
              >
                Close
              </button>
              <button
                type="button"
                className="update-modal-btn primary"
                onClick={handleInstall}
              >
                Try again
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="update-modal-btn tertiary"
                onClick={handleDismissThisVersion}
                title="Stop reminding me about this specific version"
              >
                Skip this version
              </button>
              <button
                type="button"
                className="update-modal-btn secondary"
                onClick={handleLater}
              >
                Later
              </button>
              <button
                type="button"
                className="update-modal-btn primary"
                onClick={handleInstall}
              >
                Install
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(value < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}
