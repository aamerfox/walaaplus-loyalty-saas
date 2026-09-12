"use client";

import { useTranslations } from "next-intl";
import { Link, usePathname } from "@/i18n/routing";
import { LayoutDashboard, Users, CreditCard, Settings, LogOut, QrCode, PieChart, ShieldCheck, MapPin, BellRing, Star, Share2, FileText, Server, Layers, ScanLine } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Routes with a real implementation behind them. Every other entry below is a visual prototype
 * from the original mock-up and stays HIDDEN until its phase lands (docs/PHASE-PLAN.md), so no one
 * mistakes a mock for a feature. Add a route here in the same commit that implements it.
 */
const IMPLEMENTED_ROUTES: ReadonlySet<string> = new Set([
  "/business",
  "/business/program",
  "/business/customers",
  "/business/team",
  "/scanner",
]);

export default function Sidebar() {
  const t = useTranslations("Navigation");
  const pathname = usePathname();
  
  const navItems = [
    { name: t("dashboard"), href: "/business", icon: LayoutDashboard },
    { name: t("program"), href: "/business/program", icon: CreditCard },
    { name: t("scanner"), href: "/scanner", icon: ScanLine },
    { name: t("customers"), href: "/business/customers", icon: Users },
    { name: t("rfm"), href: "/business/rfm", icon: PieChart },
    { name: t("cards"), href: "/business/cards/templates", icon: CreditCard },
    { name: t("templates"), href: "/business/cards/builder", icon: Layers },
    { name: t("forms"), href: "/business/forms", icon: FileText },
    { name: t("distribution"), href: "/business/distribution", icon: QrCode },
    { name: t("locations"), href: "/business/locations", icon: MapPin },
    { name: t("push"), href: "/business/push", icon: BellRing },
    { name: t("feedback"), href: "/business/feedback", icon: Star },
    { name: t("referrals"), href: "/business/referrals", icon: Share2 },
    { name: t("developer"), href: "/business/developer", icon: Server },
    { name: t("team"), href: "/business/team", icon: ShieldCheck },
    { name: t("billing"), href: "/business/billing", icon: CreditCard },
    { name: t("settings"), href: "/business/settings", icon: Settings },
  ].filter((item) => IMPLEMENTED_ROUTES.has(item.href));

  return (
    <aside className="w-64 bg-white dark:bg-zinc-950 border-e border-zinc-200 dark:border-zinc-800 flex flex-col h-screen transition-all duration-300 shadow-sm">
      <div className="p-6 border-b border-zinc-200 dark:border-zinc-800 flex items-center gap-3">
        <div className="w-8 h-8 rounded-full bg-indigo-600 flex items-center justify-center shadow-inner">
             <span className="text-white font-bold text-lg">W</span>
        </div>
        <span className="font-bold text-xl tracking-tight text-zinc-900 dark:text-zinc-100">WalaaPlus</span>
      </div>
      
      <nav className="flex-1 p-4 space-y-2 overflow-y-auto">
        {navItems.map((item) => {
          const isActive = pathname === item.href;
          const Icon = item.icon;
          
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-3 px-4 py-3 rounded-xl transition-all duration-200 font-medium whitespace-nowrap",
                isActive 
                  ? "bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-400" 
                  : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800/50 hover:text-zinc-900 dark:hover:text-zinc-100"
              )}
            >
              <Icon className={cn("w-5 h-5 flex-shrink-0", isActive ? "text-indigo-600 dark:text-indigo-400" : "text-zinc-400")} />
              {item.name}
            </Link>
          );
        })}
      </nav>

      <div className="p-4 border-t border-zinc-200 dark:border-zinc-800">
        <button className="flex items-center gap-3 px-4 py-3 w-full rounded-xl text-rose-600 font-medium hover:bg-rose-50 dark:hover:bg-rose-500/10 transition-colors">
          <LogOut className="w-5 h-5 flex-shrink-0" />
          {t("logout")}
        </button>
      </div>
    </aside>
  );
}
