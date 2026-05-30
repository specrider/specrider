import { getCurrentWindow } from "@tauri-apps/api/window";
import React, { lazy, Suspense } from "react";
import ReactDOM from "react-dom/client";
import { BootFallback } from "./components/BootFallback";
import { installLongTaskObserver } from "./perf/longTasks";
import { applyPlatformClass } from "./settings/platform";
import { applyStartupTheme } from "./settings/startupTheme";
import { SettingsProvider } from "./settings/store";
import "katex/dist/katex.min.css";
import "./styles.css";

const MainWindow = lazy(() =>
  import("./MainWindow").then((mod) => ({ default: mod.MainWindow })),
);
const Settings = lazy(() =>
  import("./settings/Settings").then((mod) => ({ default: mod.Settings })),
);

applyPlatformClass();
applyStartupTheme();
installLongTaskObserver();

const isSettings = getCurrentWindow().label === "settings";
const WindowRoot = isSettings ? Settings : MainWindow;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <SettingsProvider>
      <Suspense fallback={<BootFallback />}>
        <WindowRoot />
      </Suspense>
    </SettingsProvider>
  </React.StrictMode>,
);
