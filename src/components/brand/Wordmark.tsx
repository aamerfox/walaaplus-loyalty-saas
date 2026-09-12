import { cn } from "@/lib/utils";

/**
 * The Zademi wordmark.
 *
 * ## Why this is a text wordmark and not the logo
 *
 * There is **no approved Zademi logo asset in this repository** — no SVG, no PNG, no source file.
 * The only artwork that exists is inside a PDF, and tracing it, extracting its paths or
 * approximating it by eye would put a drawing nobody approved on every screen of the product and on
 * every customer's home screen, where it is hardest to take back.
 *
 * So this renders the product name in the brand's own type, next to a deliberately NEUTRAL mark: a
 * rounded navy tile with a turquoise diamond, which is a placeholder that looks finished rather
 * than a placeholder that looks broken. When the real asset arrives it replaces `<BrandMark>` and
 * nothing else changes.
 *
 * The exact missing asset is recorded in `docs/BRAND.md`.
 */

export function BrandMark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-xl bg-navy-900 text-white shadow-sm",
        "size-9",
        className,
      )}
    >
      {/* A diamond, from the brand's layered-diamond language. Geometry only: nothing traced. */}
      <svg viewBox="0 0 24 24" className="size-5" fill="none" role="presentation">
        <path d="M12 3.2 20.8 12 12 20.8 3.2 12 12 3.2Z" fill="#00B3A4" />
        <path d="M12 7.6 16.4 12 12 16.4 7.6 12 12 7.6Z" fill="#0B2D5B" />
      </svg>
    </span>
  );
}

export function Wordmark({
  className,
  markClassName,
  showName = true,
}: {
  className?: string;
  markClassName?: string;
  showName?: boolean;
}) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <BrandMark className={markClassName} />
      {showName ? (
        // Not translated, and not a message key: a product name is the same word in every locale,
        // and putting it in the message files invites a well-meaning translation of it.
        <span className="font-display text-xl font-extrabold tracking-tight text-ink">Zademi</span>
      ) : null}
    </span>
  );
}
