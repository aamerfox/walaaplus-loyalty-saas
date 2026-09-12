import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The small set of pieces every Zademi screen is built from.
 *
 * Not a component library — a vocabulary. Each one exists because the same markup was about to be
 * written for the third time, and each one takes its colour from the semantic tokens in
 * `globals.css` rather than from a hex value typed at the call site. That is what makes a brand
 * change one file instead of forty, and what stops a contrast decision made here being unmade on
 * the next screen.
 *
 * Everything here is a server component: no state, no effects, no `"use client"`. The interactive
 * parts of a screen are small islands that import these for their shell.
 */

export function Card({
  children,
  className,
  as: Tag = "div",
  testId,
}: {
  children: ReactNode;
  className?: string;
  as?: "div" | "section" | "li" | "article";
  testId?: string;
}) {
  return (
    <Tag data-testid={testId} className={cn("rounded-2xl border border-border bg-surface p-5 shadow-sm sm:p-6", className)}>
      {children}
    </Tag>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className="font-display text-2xl font-extrabold tracking-tight text-ink sm:text-3xl">{title}</h1>
        {subtitle ? <p className="mt-1 text-sm text-ink-muted sm:text-base">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

/**
 * A status badge.
 *
 * `tone` never travels alone: every caller pairs it with a word. Colour is the second cue here, not
 * the first — a cashier reading this on a bright counter in daylight, or anyone with a red/green
 * deficiency, gets the meaning from the label.
 */
export function Badge({
  children,
  tone = "neutral",
  className,
}: {
  children: ReactNode;
  tone?: "neutral" | "brand" | "success" | "warn" | "danger";
  className?: string;
}) {
  const tones = {
    neutral: "bg-surface-muted text-ink-muted ring-border",
    brand: "bg-navy-50 text-navy-900 ring-navy-200 dark:bg-navy-800 dark:text-white dark:ring-navy-600",
    success: "bg-success-bg text-success-ink ring-transparent",
    warn: "bg-warn-bg text-warn-ink ring-transparent",
    danger: "bg-danger-bg text-danger-ink ring-transparent",
  } as const;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset",
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/** One ledger-derived figure. The label carries the definition; the number carries nothing else. */
export function StatTile({
  label,
  value,
  hint,
}: {
  label: string;
  value: string | number;
  hint?: string;
}) {
  return (
    <Card className="p-4 sm:p-5">
      <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">{label}</p>
      <p className="mt-1 font-display text-2xl font-extrabold tabular-nums text-ink sm:text-3xl">{value}</p>
      {hint ? <p className="mt-1 text-xs text-ink-muted">{hint}</p> : null}
    </Card>
  );
}

/**
 * What a screen shows when there is nothing yet.
 *
 * An empty state is a first impression, and "no data" is not one. Every caller passes what to do
 * next, because a merchant who has just signed up sees more empty screens than full ones.
 */
export function EmptyState({
  title,
  body,
  action,
  testId,
}: {
  title: string;
  body: string;
  action?: ReactNode;
  testId?: string;
}) {
  return (
    <Card className="text-center" testId={testId}>
      <p className="font-display text-lg font-bold text-ink">{title}</p>
      <p className="mx-auto mt-2 max-w-prose text-sm text-ink-muted">{body}</p>
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
    </Card>
  );
}

/**
 * A message about what just happened, or what cannot.
 *
 * `role="status"` for the good news and `role="alert"` for the bad, so a screen reader announces a
 * result the sighted user reads as a colour change. The icon glyph is a second non-colour cue.
 */
export function Notice({
  tone,
  children,
  testId,
}: {
  tone: "info" | "success" | "warn" | "danger";
  children: ReactNode;
  testId?: string;
}) {
  const tones = {
    info: { cls: "bg-navy-50 text-navy-900 dark:bg-navy-800 dark:text-white", glyph: "i", role: "status" as const },
    success: { cls: "bg-success-bg text-success-ink", glyph: "✓", role: "status" as const },
    warn: { cls: "bg-warn-bg text-warn-ink", glyph: "!", role: "status" as const },
    danger: { cls: "bg-danger-bg text-danger-ink", glyph: "!", role: "alert" as const },
  };
  const { cls, glyph, role } = tones[tone];
  return (
    <p role={role} data-testid={testId} className={cn("flex items-start gap-2 rounded-xl px-4 py-3 text-sm font-medium", cls)}>
      <span aria-hidden="true" className="mt-0.5 font-bold">
        {glyph}
      </span>
      <span>{children}</span>
    </p>
  );
}

/** A labelled row in a definition list. Used wherever a screen explains a configured rule. */
export function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-border py-3 last:border-0">
      <dt className="text-sm text-ink-muted">{label}</dt>
      <dd className="text-sm font-semibold text-ink">{children}</dd>
    </div>
  );
}

/**
 * Progress towards a reward.
 *
 * The number is inside the bar's accessible name, not only in its width: a progress bar that is
 * announced as "62%" tells a screen-reader user nothing about stamps, and a customer standing at a
 * counter wants "7 of 10".
 */
export function ProgressBar({ value, max, label }: { value: number; max: number; label: string }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div
      role="progressbar"
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-label={label}
      className="h-2.5 w-full overflow-hidden rounded-full bg-border"
    >
      <div className="h-full rounded-full bg-mint-500 transition-[width] duration-500" style={{ width: `${pct}%` }} />
    </div>
  );
}
