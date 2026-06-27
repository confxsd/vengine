import { cva, type VariantProps } from "class-variance-authority";
import { forwardRef } from "react";
import { cn } from "@/lib/cn";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap transition-[background,color,opacity,box-shadow] duration-100 disabled:opacity-40 disabled:pointer-events-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent",
  {
    variants: {
      variant: {
        // High-contrast neutral — the primary action on a surface.
        default: "bg-text text-bg hover:opacity-90",
        // Brand accent — the one "Run"-style call to action.
        accent: "bg-accent text-accent-contrast hover:bg-accent-hover",
        // Quiet filled — secondary controls.
        secondary: "bg-elevated text-text hover:bg-border-strong/60",
        // No chrome until hover — toolbar/inline actions.
        ghost: "text-muted hover:bg-elevated hover:text-text",
        // Hairline outline — alternative quiet action.
        outline:
          "border border-border-strong bg-transparent text-muted hover:text-text hover:border-accent/60",
        destructive: "text-down hover:bg-down/10",
        link: "px-0 text-accent hover:underline underline-offset-2",
      },
      size: {
        sm: "h-7 px-2.5 text-xs",
        md: "h-8 px-3 text-xs",
        lg: "h-9 px-4 text-sm",
        icon: "h-8 w-8",
        "icon-sm": "h-7 w-7",
      },
    },
    defaultVariants: { variant: "default", size: "md" },
  },
);

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants>;

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, type = "button", ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  ),
);
Button.displayName = "Button";

export { buttonVariants };
