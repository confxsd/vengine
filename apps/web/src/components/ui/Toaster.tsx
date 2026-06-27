import { Toaster as SonnerToaster } from "sonner";
import { useTheme } from "@/theme/useTheme";

/** App-wide toast host, themed to match the active theme + design tokens. */
export function Toaster() {
  const theme = useTheme((s) => s.theme);
  return (
    <SonnerToaster
      theme={theme}
      position="bottom-right"
      toastOptions={{
        style: {
          background: "var(--v-card)",
          color: "var(--v-text)",
          border: "1px solid var(--v-border)",
          borderRadius: "var(--r-lg)",
          fontSize: "var(--t-md)",
        },
      }}
    />
  );
}
