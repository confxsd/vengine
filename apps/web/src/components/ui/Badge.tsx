import { cva, type VariantProps } from "class-variance-authority";
import { forwardRef } from "react";
import { cn } from "@/lib/cn";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-sm px-1.5 py-px text-[10px] font-medium uppercase tracking-[0.06em] leading-4",
  {
    variants: {
      tone: {
        neutral: "bg-elevated text-muted",
        accent: "bg-accent-soft text-accent",
        up: "bg-up/12 text-up",
        down: "bg-down/12 text-down",
        amber: "bg-amber/12 text-amber",
        cyan: "bg-cyan/12 text-cyan",
        purple: "bg-purple/12 text-purple",
        outline: "border border-border-strong text-muted",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

export type BadgeProps = React.HTMLAttributes<HTMLSpanElement> &
  VariantProps<typeof badgeVariants>;

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(
  ({ className, tone, ...props }, ref) => (
    <span ref={ref} className={cn(badgeVariants({ tone }), className)} {...props} />
  ),
);
Badge.displayName = "Badge";

export { badgeVariants };
