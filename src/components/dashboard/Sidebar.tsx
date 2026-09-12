"use client";

import { useTranslations } from "next-intl";
import { Link, usePathname } from "@/i18n/routing";
import { CreditCard, LayoutDashboard, MapPin, ScanLine, ShieldCheck, Users } from "lucide-react";
import { Wordmark } from "@/components/brand/Wordmark";
import { cn } from "@/lib/utils";
import SignOutButton from "./SignOutButton";

/**
 * The merchant navigation.
 *
 * **Every entry here has a real page behind it.** The list used to carry seventeen items and filter
 * fifteen of them out, because the visual prototypes they pointed at were deleted: each rendered
 * invented figures to any signed-in user who typed the URL, cashiers included. The filter was the
 * right fix at the time; keeping a list of links to pages that do not exist is not, because the
 * next person to add a page adds it to the wrong list and the entry appears before the
 * authorization does.
 *
 * So the rule is now simpler and harder to get wrong: **to add a link, build the page.** What the
 * product intends to become lives in `docs/PHASE-PLAN.md`, which is where a roadmap belongs.
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
    <aside className="flex h-full w-64 flex-col border-e border-border bg-surface">
      <div className="border-b border-border p-5">
        <Link href="/business" onClick={onNavigate} className="inline-flex" aria-label="Zademi">
          <Wordmark />
        </Link>
      </div>

      <nav aria-label={t("primary")} className="flex-1 space-y-1 overflow-y-auto p-3">
        {navItems.map((item) => {
          // `startsWith` so a detail page keeps its section highlighted, with the dashboard pinned
          // to an exact match - otherwise "/business" would light up on every page below it.
          const isActive = item.href === "/business" ? pathname === item.href : pathname.startsWith(item.href);
          const Icon = item.icon;

          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={onNavigate}
              aria-current={isActive ? "page" : undefined}
              className={cn(
                "flex items-center gap-3 rounded-xl px-4 py-3 font-medium transition-colors",
                isActive
                  ? "bg-navy-50 text-navy-900 dark:bg-navy-800 dark:text-white"
                  : "text-ink-muted hover:bg-surface-muted hover:text-ink",
              )}
            >
              <Icon className="size-5 shrink-0" aria-hidden="true" />
              <span className="truncate">{item.name}</span>
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-border p-3">
        <SignOutButton />
      </div>
    </aside>
  );
}
