import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The Zademi vocabulary: every piece a screen is built from.
 *
 * ## Why this file grew
 *
 * The first pass shipped six primitives and left every screen to invent the rest — its own button
 * padding, its own input height, its own table density, its own way of grouping numbers. The result
 * was reviewed by the owner and rejected in one sentence: it looked like several old pages recoloured
 * in navy rather than one product. That is what happens when a design system owns the colours and
 * nothing else.
 *
 * So the vocabulary now covers the things that were being re-decided per screen:
 *
 * | Decision | Made once, here |
 * |---|---|
 * | Button hierarchy | `Button` — `primary`, `accent`, `secondary`, `ghost`, `danger`, two sizes |
 * | Form control height and focus | `Field`, `TextInput`, `SelectInput` — one 44 px control everywhere |
 * | Surface grouping | `Card`, `Section` — one radius, one border, one elevation |
 * | Page rhythm | `PageHeader`, `Toolbar` — one header height, one gap |
 * | Numbers | `StatGroup` + `StatTile` — grouped by operational meaning, never a flat field of tiles |
 * | Tables | `Table`, `Th`, `Td` — one density, RTL-aware alignment |
 * | States | `EmptyState`, `Notice`, `Skeleton`, `Spinner` |
 *
 * ## Rules every piece keeps
 *
 * - **Logical properties only.** `ms/me/ps/pe/start/end`, never `ml/mr/left/right`: an Arabic screen
 *   built with physical properties is a broken screen.
 * - **Colour is never the only cue.** Tones pair with a word and a glyph.
 * - **No brand hex at a call site.** Everything reads the semantic tokens from `globals.css`, which
 *   `tests/unit/brand-scan.test.ts` enforces.
 *
 * Everything here is a server component unless a screen needs interactivity; the interactive parts
 * are small islands that import these for their shell.
 */

/* ─────────────────────────────────────────────────────────────────────────────
 * Surfaces
 * ────────────────────────────────────────────────────────────────────────── */

export function Card({
  children,
  className,
  as: Tag = "div",
  testId,
  padded = true,
}: {
  children: ReactNode;
  className?: string;
  as?: "div" | "section" | "li" | "article";
  testId?: string;
  padded?: boolean;
}) {
  return (
    <Tag
      data-testid={testId}
      className={cn(
        "rounded-2xl border border-border bg-surface shadow-[0_1px_2px_rgba(11,45,91,0.04),0_8px_24px_-16px_rgba(11,45,91,0.18)]",
        padded && "p-5 sm:p-6",
        className,
      )}
    >
      {children}
    </Tag>
  );
}

/**
 * A titled group of related things.
 *
 * The unit the dashboard was missing: twelve identical tiles in one grid is a field of numbers, and
 * a merchant reads it as noise. Three sections of four, each with a heading that says what the four
 * have in common, is the same data and a different screen.
 */
export function Section({
  title,
  description,
  actions,
  children,
  testId,
  className,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  testId?: string;
  className?: string;
}) {
  return (
    <section data-testid={testId} className={cn("space-y-3", className)}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-display text-lg font-bold tracking-tight text-ink">{title}</h2>
          {description ? <p className="mt-0.5 text-sm text-ink-muted">{description}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

/**
 * The top of a page: one title, one line of explanation, the primary action.
 *
 * It carries **no tenant name**. Which business you are acting for is a property of the session, not
 * of the page, and repeating it above every heading is how a shop's own name ends up reading like
 * the product's — which is precisely what the owner rejected. It lives in one labelled control in
 * the shell instead.
 */
export function PageHeader({
  title,
  description,
  actions,
  back,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  back?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-4 border-b border-border pb-5 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 space-y-1">
        {back}
        <h1 className="font-display text-2xl font-extrabold tracking-tight text-ink sm:text-3xl">{title}</h1>
        {description ? <p className="max-w-prose text-sm text-ink-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

/** A row of controls above a list: filters on one side, actions on the other. */
export function Toolbar({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("flex flex-wrap items-center gap-3", className)}>{children}</div>;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Actions
 * ────────────────────────────────────────────────────────────────────────── */

type ButtonVariant = "primary" | "accent" | "secondary" | "ghost" | "danger";

const BUTTON_BASE =
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-50";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  /** The one action a screen most wants you to take. Navy ground, white text: 12.6:1. */
  primary: "bg-navy-900 text-white hover:bg-navy-800 dark:bg-white dark:text-navy-900 dark:hover:bg-navy-100",
  /**
   * The loyalty action — award, redeem, the thing that moves value.
   *
   * Turquoise carries navy-950 text rather than white: the accent under white is 2.6:1 and fails, and
   * a button nobody can read is not a brand moment.
   */
  accent: "bg-turquoise-500 text-navy-950 hover:bg-turquoise-600",
  secondary: "border border-border bg-surface text-ink hover:bg-surface-muted",
  ghost: "text-ink-muted hover:bg-surface-muted hover:text-ink",
  danger: "border border-transparent bg-danger-bg text-danger-ink hover:brightness-95",
};

const BUTTON_SIZES = {
  /** 44 px: the minimum comfortable touch target, and the height every form control shares. */
  md: "h-11 px-5 text-sm",
  lg: "h-12 px-6 text-base",
  sm: "h-9 px-3.5 text-sm",
} as const;

export function Button({
  variant = "primary",
  size = "md",
  className,
  testId,
  ...props
}: ComponentProps<"button"> & { variant?: ButtonVariant; size?: keyof typeof BUTTON_SIZES; testId?: string }) {
  return (
    <button
      data-testid={testId}
      className={cn(BUTTON_BASE, BUTTON_VARIANTS[variant], BUTTON_SIZES[size], className)}
      {...props}
    />
  );
}

/** A link that looks like a button. Same hierarchy, so a navigation never looks like a lesser action. */
export function buttonClass(variant: ButtonVariant = "primary", size: keyof typeof BUTTON_SIZES = "md") {
  return cn(BUTTON_BASE, BUTTON_VARIANTS[variant], BUTTON_SIZES[size]);
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Forms
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * One labelled control.
 *
 * The label is a real `<label>` bound by `htmlFor`, the hint and the error are bound by
 * `aria-describedby`, and an invalid field says so with `aria-invalid` rather than only with a red
 * ring. A form that communicates its errors in colour alone is a form that cannot be filled in by
 * someone who cannot see the colour.
 */
export function Field({
  id,
  label,
  hint,
  error,
  children,
  className,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <label htmlFor={id} className="block text-sm font-semibold text-ink">
        {label}
      </label>
      {children}
      {hint && !error ? (
        <p id={`${id}-hint`} className="text-xs text-ink-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p
          id={`${id}-error`}
          data-testid={`${id}-error`}
          role="alert"
          className="flex items-center gap-1.5 text-xs font-semibold text-danger-ink"
        >
          <span aria-hidden="true">!</span>
          {error}
        </p>
      ) : null}
    </div>
  );
}

const CONTROL =
  "h-11 w-full rounded-xl border border-border bg-surface px-4 text-sm text-ink placeholder:text-ink-faint outline-none transition-colors focus:border-turquoise-500 disabled:opacity-60 aria-[invalid=true]:border-danger-ink";

export function TextInput({ className, ...props }: ComponentProps<"input">) {
  return <input className={cn(CONTROL, className)} {...props} />;
}

export function SelectInput({ className, children, ...props }: ComponentProps<"select">) {
  return (
    <select className={cn(CONTROL, "pe-10", className)} {...props}>
      {children}
    </select>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Status
 * ────────────────────────────────────────────────────────────────────────── */

export function Badge({
  children,
  tone = "neutral",
  className,
}: {
  children: ReactNode;
  tone?: "neutral" | "brand" | "accent" | "success" | "warn" | "danger";
  className?: string;
}) {
  const tones = {
    neutral: "bg-surface-muted text-ink-muted ring-border",
    brand: "bg-navy-50 text-navy-900 ring-navy-200 dark:bg-navy-800 dark:text-white dark:ring-navy-600",
    accent: "bg-turquoise-50 text-turquoise-800 ring-turquoise-200 dark:bg-turquoise-800 dark:text-white dark:ring-turquoise-600",
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

/**
 * Numbers, grouped by what they are about.
 *
 * `StatGroup` exists to make the grouping the default rather than an act of discipline on each page.
 */
export function StatGroup({
  title,
  children,
  testId,
  columns = 4,
}: {
  title: string;
  children: ReactNode;
  testId?: string;
  /**
   * How many tiles the group holds.
   *
   * A group of two in a four-column grid leaves half a row of nothing, which is the "arbitrary
   * empty space" a reader notices without being able to name. The group says how wide it is instead
   * of every screen guessing.
   */
  columns?: 2 | 3 | 4;
}) {
  /*
   * Two columns from the smallest screen up. A dashboard whose tiles are one per row on a phone is
   * a dashboard a merchant scrolls rather than reads, and these tiles are a label and a number.
   */
  const grid = { 2: "grid-cols-2 xl:max-w-2xl", 3: "grid-cols-2 lg:grid-cols-3", 4: "grid-cols-2 xl:grid-cols-4" } as const;
  return (
    <Section title={title} testId={testId}>
      <div className={cn("grid gap-3", grid[columns])}>{children}</div>
    </Section>
  );
}

export function StatTile({
  label,
  value,
  hint,
  tone = "plain",
  testId,
}: {
  label: string;
  value: string | number;
  hint?: string;
  /** `accent` marks the one figure in a group that carries the loyalty meaning. */
  tone?: "plain" | "accent";
  testId?: string;
}) {
  return (
    <Card className="p-4 sm:p-5" padded={false}>
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">{label}</p>
        <p
          data-testid={testId}
          className={cn(
            "mt-1 font-display text-3xl font-extrabold tabular-nums",
            tone === "accent" ? "text-accent-ink" : "text-ink",
          )}
        >
          {value}
        </p>
        {hint ? <p className="mt-1 text-xs leading-relaxed text-ink-muted">{hint}</p> : null}
      </div>
    </Card>
  );
}

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
      <div className="mx-auto flex max-w-sm flex-col items-center gap-3 py-6">
        {/* A quiet brand shape rather than an illustration: it marks the space as deliberate without
            pretending an empty screen is an event. */}
        <span aria-hidden="true" className="size-10 rounded-2xl bg-turquoise-100 dark:bg-navy-800" />
        <p className="font-display text-lg font-bold text-ink">{title}</p>
        <p className="text-sm leading-relaxed text-ink-muted">{body}</p>
        {action ? <div className="pt-1">{action}</div> : null}
      </div>
    </Card>
  );
}

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
    <p
      role={role}
      data-testid={testId}
      className={cn("flex items-start gap-2.5 rounded-xl px-4 py-3 text-sm font-medium leading-relaxed", cls)}
    >
      <span aria-hidden="true" className="mt-px font-bold">
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
 * The number is inside the bar's accessible name, not only in its width: a progress bar announced as
 * "62%" tells a screen-reader user nothing about stamps, and a customer at a counter wants "7 of 10".
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

/* ─────────────────────────────────────────────────────────────────────────────
 * Tables
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * One table density for the whole product, and one scroll behaviour.
 *
 * The wrapper scrolls, not the page: a wide table inside a phone-width layout otherwise drags the
 * whole document sideways, which in RTL is doubly disorienting.
 */
export function Table({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <div className="overflow-x-auto rounded-2xl border border-border bg-surface">
      <table
        data-testid={testId}
        /* The last ROW loses its rule, not the last CELL: `last:border-0` on a cell drew a line that
           stopped short of the card edge, which reads as a rendering fault rather than a table. */
        className="w-full border-collapse text-sm [&>tbody>tr:last-child>td]:border-0"
      >
        {children}
      </table>
    </div>
  );
}

export function Th({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <th
      scope="col"
      className={cn(
        "border-b border-border px-4 py-3 text-start text-xs font-bold uppercase tracking-wide text-ink-faint",
        className,
      )}
    >
      {children}
    </th>
  );
}

export function Td({ children, className }: { children: ReactNode; className?: string }) {
  return <td className={cn("border-b border-border px-4 py-3.5 text-ink", className)}>{children}</td>;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Waiting
 * ────────────────────────────────────────────────────────────────────────── */

export function Spinner({ className, label }: { className?: string; label: string }) {
  return (
    <span role="status" className={cn("inline-flex items-center gap-2 text-sm text-ink-muted", className)}>
      <span
        aria-hidden="true"
        className="size-4 animate-spin rounded-full border-2 border-border border-t-turquoise-500"
      />
      {label}
    </span>
  );
}

/** A loading placeholder shaped like the thing that is coming, not a spinner in the middle of a page. */
export function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden="true" className={cn("block animate-pulse rounded-lg bg-border", className)} />;
}
