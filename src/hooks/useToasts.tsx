// Lightweight app-wide toast queue. Used by git actions to surface
// success / error feedback ("Committed: …", "Pushing to main is
// disabled", etc.) without taking over the screen.
//
// The shape is intentionally small — this isn't a notification system,
// it's a 4-line ephemeral message strip pinned above the status bar.

import {
  createContext,
  type PropsWithChildren,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";

export type ToastTone = "info" | "success" | "warn" | "error";

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface ToastEntry {
  id: number;
  tone: ToastTone;
  message: string;
  action?: ToastAction;
}

interface ToastContextValue {
  toasts: ToastEntry[];
  push: (
    message: string,
    options?: { tone?: ToastTone; action?: ToastAction; durationMs?: number },
  ) => void;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const DEFAULT_DURATION = 4000;

export function ToastProvider({ children }: PropsWithChildren): ReactNode {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const idRef = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (
      message: string,
      options?: {
        tone?: ToastTone;
        action?: ToastAction;
        durationMs?: number;
      },
    ) => {
      const id = ++idRef.current;
      const entry: ToastEntry = {
        id,
        tone: options?.tone ?? "info",
        message,
        action: options?.action,
      };
      setToasts((prev) => [...prev, entry]);
      const duration = options?.durationMs ?? DEFAULT_DURATION;
      if (duration > 0) {
        window.setTimeout(() => dismiss(id), duration);
      }
    },
    [dismiss],
  );

  const value = useMemo(
    () => ({ toasts, push, dismiss }),
    [toasts, push, dismiss],
  );

  return (
    <ToastContext.Provider value={value}>{children}</ToastContext.Provider>
  );
}

export function useToasts(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToasts must be used inside <ToastProvider>");
  return ctx;
}

export function ToastViewport(): ReactNode {
  const { toasts, dismiss } = useToasts();
  // Two viewports: error-tone toasts go through the assertive
  // (role="alert") channel so SR users hear them immediately;
  // everything else stays polite. Always rendered so the live regions
  // exist when the first toast arrives — SR clients only announce
  // changes inside an existing aria-live region.
  const errors = toasts.filter((t) => t.tone === "error");
  const polite = toasts.filter((t) => t.tone !== "error");
  return (
    <>
      <section
        className="toast-viewport"
        aria-label="Notifications"
        aria-live="polite"
      >
        {polite.map((t) => (
          <ToastRow key={t.id} entry={t} onDismiss={dismiss} />
        ))}
      </section>
      <div
        className="toast-viewport toast-viewport-alerts"
        role="alert"
        aria-label="Errors"
        aria-live="assertive"
      >
        {errors.map((t) => (
          <ToastRow key={t.id} entry={t} onDismiss={dismiss} />
        ))}
      </div>
    </>
  );
}

function ToastRow({
  entry,
  onDismiss,
}: {
  entry: ToastEntry;
  onDismiss: (id: number) => void;
}) {
  return (
    <div className={`toast toast-${entry.tone}`}>
      <span className="toast-message">{entry.message}</span>
      {entry.action && (
        <button
          type="button"
          className="toast-action"
          onClick={() => {
            entry.action?.run();
            onDismiss(entry.id);
          }}
        >
          {entry.action.label}
        </button>
      )}
      <button
        type="button"
        className="toast-close"
        onClick={() => onDismiss(entry.id)}
        aria-label="Dismiss"
      >
        ×
      </button>
    </div>
  );
}
