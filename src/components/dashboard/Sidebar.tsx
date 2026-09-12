"use client";

import { useTranslations } from "next-intl";
import { Link, usePathname } from "@/i18n/routing";
import { CreditCard, LayoutDashboard, MapPin, ScanLine, ShieldCheck, Users } from "lucide-react";
import { Wordmark } from "@/components/brand/Wordmark";
import { cn } from "@/lib/utils";
import SignOutButton from "./SignOutButton";

/**
 * The merchant navigation: the product's one brand surface.
 *
 * ## The logo, whole
 *
 * The rail is **navy**, and it carries the complete official wordmark in the approved white
 * treatment — one lockup, at a size where the cards, the Z and the word are legible as one mark.
 *
 * The previous shell showed the colour logo on white here and the standalone symbol in the phone
 * header, so a merchant who used both widths met two different marks and, at small sizes, read the
 * full logo as a row of unrelated shapes. The owner called them "disconnected fragments", which is
 * exactly what a 120-px-wide three-colour lockup becomes. **One treatment per surface, and the
 * symbol only where a wordmark genuinely cannot fit.**
 *
 * ## Every entry here has a page behind it
 *
 * The list used to carry seventeen items and filter fifteen out, because the prototypes they pointed
 * at were deleted. To add a link, build the page; what the product intends to become lives in
 * `docs/PHASE-PLAN.md`, which is where a roadmap belongs.
 */

export default function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const t = useTranslations("Navigation");
  const pathname = usePathname();

  const navItems = [
    { name: t("dashboard"), href: "/business", icon: LayoutDashboard },
    { name: t("programs"), href: "/business/programs", icon: CreditCard },
    { name: t("scanner"), href: "/scanner", icon: ScanLine },
    { name: t("customers"), href: "/business/customers", icon: Users },
    { name: t("locations"), href: "/business/locations", icon: MapPin },
    { name: t("team"), href: "/business/team", icon: ShieldCheck },
  ];

  return (
    <aside className="flex h-full w-64 flex-col bg-navy-900 text-white">
      <div className="px-5 py-6">
        <Link href="/business" onClick={onNavigate} aria-label="Zademi" className="inline-flex">
          {/* The approved white treatment, because this surface is navy. */}
          <Wordmark tone="white" height={30} className="h-[30px] w-auto" />
        </Link>
      </div>

      <nav aria-label={t("primary")} className="flex-1 space-y-1 overflow-y-auto px-3 pb-3">
        {navItems.map((item) => {
          // `startsWith` so a detail page keeps its section lit, with the dashboard pinned to an
          // exact match — otherwise "/business" would light up on every page beneath it.
          const isActive = item.href === "/business" ? pathname === item.href : pathname.startsWith(item.href);
          const Icon = item.icon;

          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={onNavigate}
              aria-current={isActive ? "page" : undefined}
              className={cn(
                "relative flex items-center gap-3 rounded-xl px-4 py-3 text-sm font-semibold transition-colors",
                /*
                 * The active marker is a turquoise bar INSIDE the rounded pill, not a border on it.
                 * A 4px `border-s` on a `rounded-xl` element follows the corner radius, so it drew
                 * a crescent that bulged away from the row — at a glance, a stray arc beside the
                 * navigation rather than a marker on it. A positioned bar is straight, and `start`
                 * puts it on the right in Arabic without a second rule.
                 */
                isActive
                  ? "bg-white/10 text-white before:absolute before:inset-y-2 before:start-0 before:w-1 before:rounded-full before:bg-turquoise-500"
                  : "text-white/70 hover:bg-white/5 hover:text-white",
              )}
            >
              <Icon className={cn("size-5 shrink-0", isActive ? "text-turquoise-500" : "text-white/60")} aria-hidden="true" />
              <span className="truncate">{item.name}</span>
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-white/10 p-3">
        <SignOutButton />
      </div>
    </aside>
  );
}
