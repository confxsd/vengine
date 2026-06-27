import { forwardRef } from "react";
import { Button, type ButtonProps } from "./Button";
import { cn } from "@/lib/cn";

export type IconButtonProps = Omit<ButtonProps, "size"> & {
  size?: "icon" | "icon-sm";
  label: string;
};

/** Square, icon-only button. `label` is required for accessibility. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ size = "icon", variant = "ghost", label, className, ...props }, ref) => (
    <Button
      ref={ref}
      size={size}
      variant={variant}
      aria-label={label}
      title={label}
      className={cn("shrink-0", className)}
      {...props}
    />
  ),
);
IconButton.displayName = "IconButton";
