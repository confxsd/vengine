import { Moon, Sun } from "lucide-react";
import { useTheme } from "@/theme/useTheme";
import { IconButton } from "./IconButton";

/** Dark/light switch. Icon shows the theme you'll switch *to*. */
export function ThemeToggle({ className }: { className?: string }) {
  const theme = useTheme((s) => s.theme);
  const toggle = useTheme((s) => s.toggle);
  const isDark = theme === "dark";
  return (
    <IconButton
      size="icon-sm"
      label={isDark ? "Switch to light theme" : "Switch to dark theme"}
      onClick={toggle}
      className={className}
    >
      {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </IconButton>
  );
}
