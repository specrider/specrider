import App from "./App";
import { GitStatusProvider } from "./hooks/gitStatusContext";
import { ToastProvider } from "./hooks/useToasts";
import { PinsProvider } from "./pins/store";

export function MainWindow() {
  return (
    <PinsProvider>
      <ToastProvider>
        <GitStatusProvider>
          <App />
        </GitStatusProvider>
      </ToastProvider>
    </PinsProvider>
  );
}
