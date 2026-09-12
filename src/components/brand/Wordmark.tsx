import Image from "next/image";
import { cn } from "@/lib/utils";

/**
 * The Zademi logo.
 *
 * The approved masters live in `public/brand/` exactly as they were supplied — the two SVGs are the
 * canonical artwork, the PNGs are the approved treatments, and nothing in this repository traces,
 * recolours or rasterises them. Everything a screen draws comes from one of those five files, or
 * from a derivative rendered off the approved icon by `scripts/make-icons.mjs`.
 *
 * | Component | Asset | Where |
 * |---|---|---|
 * | `<Wordmark />` | `Zademi-Logo.svg` | headers, sign-in, anywhere with room for the full logo |
 * | `<Wordmark tone="white" />` | `Zademi-Logo-White.png` | navy and dark surfaces |
 * | `<Wordmark tone="dark" />` | `Zademi-Logo-Dark.png` | tinted light surfaces wanting one flat colour |
 * | `<BrandMark />` | `Zademi-Symbol.svg` | compact navigation, avatars, tight spaces |
 *
 * The SVGs are served `unoptimized`: Next's image optimiser declines SVG by default, and a vector
 * that is already 35 KB and scales to any size has nothing to gain from being turned into a raster.
 *
 * `alt` is empty and `aria-hidden` is set wherever the logo sits next to the product name in text,
 * because a screen reader announcing "Zademi Zademi" is worse than one that announces it once. The
 * `aria-label` on the link is what carries the name in those places.
 */

/** Intrinsic ratio of the full logo: 2048 × 544 in the master, so 3.76 : 1. */
const LOGO_RATIO = 2048 / 544;

export type BrandTone = "colour" | "dark" | "white";

const LOGO_SRC: Record<BrandTone, string> = {
  colour: "/brand/Zademi-Logo.svg",
  dark: "/brand/Zademi-Logo-Dark.png",
  white: "/brand/Zademi-Logo-White.png",
};

export function BrandMark({ className, size = 36 }: { className?: string; size?: number }) {
  return (
    <Image
      src="/brand/Zademi-Symbol.svg"
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      unoptimized
      priority
      className={cn("shrink-0", className)}
    />
  );
}

export function Wordmark({
  className,
  tone = "colour",
  height = 32,
}: {
  className?: string;
  tone?: BrandTone;
  /** Rendered height in pixels. The width follows the master's own ratio. */
  height?: number;
}) {
  return (
    <Image
      src={LOGO_SRC[tone]}
      alt="Zademi"
      width={Math.round(height * LOGO_RATIO)}
      height={height}
      unoptimized={tone === "colour"}
      priority
      className={cn("h-8 w-auto", className)}
    />
  );
}
