import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { listCustomThemes, onThemesChanged } from "../tauri/api";
import { cacheStartupSettings } from "./startupTheme";
import { BUILTIN_THEMES, checkThemeContrast, type Theme } from "./themes";
import {
  type AppSettings,
  EMPTY_SETTINGS,
  type ResolvedSettings,
  resolve,
} from "./types";

interface SettingsContextValue {
  raw: AppSettings;
  effective: ResolvedSettings;
  loaded: boolean;
  /** Built-in themes + per-window custom themes loaded from
   *  `<app_config>/themes/*.json`. */
  themes: Theme[];
  customThemes: Theme[];
  update: <K extends keyof AppSettings>(
    key: K,
    value: AppSettings[K],
  ) => Promise<void>;
  reset: (section: string) => Promise<void>;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [raw, setRaw] = useState<AppSettings>(EMPTY_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const [customThemes, setCustomThemes] = useState<Theme[]>([]);

  useEffect(() => {
    invoke<AppSettings>("get_settings")
      .then((s) => {
        cacheStartupSettings(s);
        setRaw(s);
        setLoaded(true);
      })
      .catch((e) => console.error("get_settings failed:", e));

    let unlistenSettings: UnlistenFn | undefined;
    listen<AppSettings>("settings-changed", (event) => {
      cacheStartupSettings(event.payload);
      setRaw(event.payload);
    }).then((u) => {
      unlistenSettings = u;
    });

    // Custom themes — app-wide. Initial load + refresh whenever the
    // themes folder watcher fires `themes-changed`.
    const refreshCustomThemes = () => {
      listCustomThemes()
        .then((raw) => {
          const themes = raw.map((r) => ({
            id: r.id,
            name: r.name,
            type: r.type,
            author: r.author,
            variables: r.variables,
          }));
          // Surface low-contrast custom themes so authors learn about
          // the focus-ring constraint before users hit it.
          for (const t of themes) {
            const warn = checkThemeContrast(t);
            if (warn) console.warn(warn);
          }
          setCustomThemes(themes);
        })
        .catch((e) => console.error("listCustomThemes failed:", e));
    };
    refreshCustomThemes();

    let unlistenThemes: UnlistenFn | undefined;
    onThemesChanged(refreshCustomThemes).then((u) => {
      unlistenThemes = u;
    });

    return () => {
      unlistenSettings?.();
      unlistenThemes?.();
    };
  }, []);

  const update = useCallback(
    async <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
      // Optimistic — UI updates immediately; if the IPC fails we recover
      // from a fresh fetch.
      setRaw((prev) => {
        const next = { ...prev, [key]: value };
        cacheStartupSettings(next);
        return next;
      });
      try {
        await invoke("set_setting", { key, value });
      } catch (e) {
        console.error("set_setting failed:", e);
        try {
          const fresh = await invoke<AppSettings>("get_settings");
          cacheStartupSettings(fresh);
          setRaw(fresh);
        } catch {
          /* ignore secondary failure */
        }
      }
    },
    [],
  );

  const reset = useCallback(async (section: string) => {
    try {
      await invoke("reset_settings", { section });
    } catch (e) {
      console.error("reset_settings failed:", e);
    }
  }, []);

  const effective = useMemo(() => resolve(raw), [raw]);
  const themes = useMemo(
    () => [...BUILTIN_THEMES, ...customThemes],
    [customThemes],
  );
  const value = useMemo(
    () => ({ raw, effective, loaded, themes, customThemes, update, reset }),
    [raw, effective, loaded, themes, customThemes, update, reset],
  );

  return (
    <SettingsContext.Provider value={value}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext);
  if (!ctx)
    throw new Error("useSettings must be used inside <SettingsProvider>");
  return ctx;
}
