"use client";

import { Bell, Search, Globe } from "lucide-react";
import { useRouter, usePathname } from "@/i18n/routing";
import { useLocale } from "next-intl";

export default function Header() {
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();

  const toggleLanguage = () => {
    const nextLocale = locale === "en" ? "ar" : "en";
    router.replace(pathname, { locale: nextLocale });
  };

  return (
    <header className="h-20 bg-white/80 dark:bg-zinc-950/80 backdrop-blur-xl border-b border-zinc-200 dark:border-zinc-800 flex flex-shrink-0 items-center justify-between px-6 z-10 sticky top-0">
      
      {/* Search Bar - Logical CSS for perfect RTL */}
      <div className="flex-1 max-w-sm hidden sm:flex items-center relative">
        <Search className="w-5 h-5 text-zinc-400 absolute start-3" />
        <input 
          type="text" 
          placeholder={locale === 'ar' ? 'البحث عن العملاء أو البطاقات...' : 'Search customers or cards...'} 
          className="w-full bg-zinc-100 dark:bg-zinc-900 border-transparent focus:bg-white focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 dark:focus:border-indigo-500 dark:focus:ring-indigo-900/50 rounded-xl ps-10 pe-4 py-2.5 text-sm transition-all focus:outline-none text-zinc-900 dark:text-zinc-100 dark:placeholder-zinc-500"
        />
      </div>

      <div className="flex items-center gap-4 ms-auto">
        <button 
           onClick={toggleLanguage}
           className="px-3 py-2 text-zinc-500 font-medium text-sm hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-lg transition-colors flex items-center gap-2 border border-zinc-200 dark:border-zinc-800"
           title="Toggle Language"
        >
          <Globe className="w-4 h-4" />
          <span>{locale === 'en' ? 'AR' : 'EN'}</span>
        </button>
        
        <button className="relative p-2.5 text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-full transition-colors">
          <Bell className="w-5 h-5" />
          <span className="absolute top-2.5 end-2 w-2 h-2 bg-rose-500 rounded-full border-2 border-white dark:border-zinc-950"></span>
        </button>

        <div className="w-10 h-10 rounded-full bg-indigo-100 dark:bg-indigo-900/40 border border-indigo-200 dark:border-indigo-800/60 flex items-center justify-center overflow-hidden cursor-pointer shadow-sm hover:ring-2 ring-indigo-500 ring-offset-2 dark:ring-offset-zinc-950 transition-all">
           {/* Initials, not a remote avatar service: rendering one would send the account
               name to a third party on every dashboard load. Real avatars arrive with the
               account UI in Phase 1b. */}
           <span className="font-semibold text-indigo-700 dark:text-indigo-300 select-none" aria-hidden="true">BO</span>
           <span className="sr-only">Business Owner</span>
        </div>
      </div>
    </header>
  );
}
