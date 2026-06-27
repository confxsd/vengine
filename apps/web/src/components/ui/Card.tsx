import { forwardRef } from "react";
import { cn } from "@/lib/cn";

/** Flat surface that lifts above the background. Borderless by default —
 *  pass `border border-border` when a hairline edge is wanted. */
export const Card = forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn("rounded-lg bg-card", className)} {...props} />
));
Card.displayName = "Card";

export const CardHeader = forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      "flex items-center justify-between gap-2 px-3 pt-2.5 pb-2",
      className,
    )}
    {...props}
  />
));
CardHeader.displayName = "CardHeader";

export const CardTitle = forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      "text-[10px] font-medium uppercase tracking-[0.12em] text-faint",
      className,
    )}
    {...props}
  />
));
CardTitle.displayName = "CardTitle";

export const CardBody = forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn("px-3 pb-3", className)} {...props} />
));
CardBody.displayName = "CardBody";

export const CardFooter = forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("border-t border-border px-3 py-2", className)}
    {...props}
  />
));
CardFooter.displayName = "CardFooter";
