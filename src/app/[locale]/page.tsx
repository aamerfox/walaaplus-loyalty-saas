"use client";

import { Wordmark } from "@/components/brand/Wordmark";
import { useTranslations, useLocale } from "next-intl";
import { Link } from "@/i18n/routing";
import { ArrowRight, Smartphone, Globe, Zap } from "lucide-react";

export default function LandingPage() {
  const t = useTranslations("Landing");
  const locale = useLocale();
  const dir = locale === 'ar' ? 'rtl' : 'ltr';

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950 font-sans text-zinc-900 dark:text-zinc-50 overflow-hidden" dir={dir}>
      
      {/* Navigation */}
      <nav className="fixed top-0 inset-x-0 z-50 bg-white/80 dark:bg-zinc-950/80 backdrop-blur-xl border-b border-zinc-200 dark:border-zinc-800">
        <div className="max-w-7xl mx-auto px-6 h-20 flex items-center justify-between">
          <Wordmark />

          <div className="hidden md:flex items-center gap-8 font-bold text-sm text-zinc-600 dark:text-zinc-400">
             <Link href="/" className="hover:text-indigo-600 transition-colors">{t('navHome')}</Link>
             <Link href="#features" className="hover:text-indigo-600 transition-colors">{t('navFeatures')}</Link>
             <Link href="/pricing" className="hover:text-indigo-600 transition-colors">{t('navPricing')}</Link>
          </div>

          <div className="flex items-center gap-4">
             <Link href="/auth/login" className="hidden sm:block font-bold text-sm tracking-wide text-zinc-600 dark:text-zinc-300 hover:text-indigo-600">
                {t('navLogin')}
             </Link>
             <Link href="/auth/register" className="bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 px-6 py-2.5 rounded-full font-bold text-sm tracking-wide shadow-lg hover:scale-105 transition-transform">
                {t('ctaStart')}
             </Link>
             {/* Language Switcher */}
             <Link href={locale === 'ar' ? '/en' : '/ar'} className="w-10 h-10 rounded-full border border-zinc-200 dark:border-zinc-800 flex items-center justify-center font-bold text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors">
                {locale === 'ar' ? 'EN' : 'ع'}
             </Link>
          </div>
        </div>
      </nav>

      {/* Hero Section */}
      <main className="relative pt-32 pb-20 sm:pt-40 sm:pb-24">
         
         {/* Background Effects */}
         <div className="absolute top-0 inset-x-0 h-screen overflow-hidden -z-10 pointer-events-none">
            <div className={`absolute top-0 ${locale === 'ar' ? '-right-1/4' : '-left-1/4'} w-[1000px] h-[1000px] bg-indigo-500/20 rounded-full blur-[120px] mix-blend-multiply opacity-70`}></div>
            <div className={`absolute bottom-0 ${locale === 'ar' ? '-left-1/4' : '-right-1/4'} w-[800px] h-[800px] bg-rose-500/10 rounded-full blur-[120px] mix-blend-multiply opacity-50`}></div>
         </div>

         <div className="max-w-7xl mx-auto px-6 text-center">
            
            <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-indigo-50 dark:bg-indigo-500/10 text-indigo-700 dark:text-indigo-400 font-bold text-xs uppercase tracking-widest mb-8 border border-indigo-200 dark:border-indigo-500/20">
               <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-indigo-500"></span>
               </span>
               {locale === 'ar' ? 'متوفر الآن في سوريا والشرق الأوسط' : 'Available now in MENA'}
            </div>

            <h1 className="text-5xl sm:text-7xl font-black tracking-tight mb-8 leading-[1.1] max-w-4xl mx-auto">
               {locale === 'ar' ? (
                  <>
                     بطاقات الولاء <span className="text-transparent bg-clip-text bg-gradient-to-r from-indigo-600 to-rose-500">في محفظة عملائك</span> مباشرةً.
                  </>
               ) : (
                  <>
                     Loyalty Cards natively in your <span className="text-transparent bg-clip-text bg-gradient-to-r from-indigo-600 to-rose-500">Customers&apos; Wallets.</span>
                  </>
               )}
            </h1>

            <p className="text-xl text-zinc-500 dark:text-zinc-400 font-medium max-w-2xl mx-auto mb-10 leading-relaxed">
               {t('heroSubtitle')}
            </p>

            <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
               <Link href="/auth/register" className="w-full sm:w-auto bg-indigo-600 hover:bg-indigo-700 text-white px-8 py-4 rounded-full font-black text-lg flex items-center justify-center gap-2 shadow-xl shadow-indigo-600/30 transition-transform active:scale-95">
                  {t('ctaStart')} 
                  <ArrowRight size={20} className={locale === 'ar' ? 'rotate-180' : ''} />
               </Link>
               <button className="w-full sm:w-auto bg-white dark:bg-zinc-900 border-2 border-zinc-200 dark:border-zinc-800 text-zinc-900 dark:text-white px-8 py-4 rounded-full font-black text-lg transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800">
                  {t('ctaDemo')}
               </button>
            </div>

            {/* Dashboard Mockup Display */}
            <div className="mt-20 relative mx-auto max-w-5xl">
               <div className="absolute inset-0 bg-gradient-to-b from-transparent to-zinc-50 dark:to-zinc-950 z-10"></div>
               <div className="rounded-t-[2.5rem] border border-zinc-200 dark:border-zinc-800 bg-white/50 dark:bg-zinc-900/50 backdrop-blur-xl p-4 sm:p-8 shadow-2xl relative overflow-hidden">
                  
                  {/* Fake UI Header */}
                  <div className="flex items-center gap-2 mb-6">
                     <div className="w-3 h-3 rounded-full bg-rose-500"></div>
                     <div className="w-3 h-3 rounded-full bg-amber-500"></div>
                     <div className="w-3 h-3 rounded-full bg-emerald-500"></div>
                  </div>

                  {/* Fake Dashboard Layout */}
                  <div className="flex gap-8">
                     <div className="hidden sm:block w-48 space-y-4 opacity-50">
                        <div className="h-8 bg-zinc-200 dark:bg-zinc-800 rounded-lg"></div>
                        <div className="h-8 bg-zinc-200 dark:bg-zinc-800 rounded-lg w-3/4"></div>
                        <div className="h-8 bg-zinc-200 dark:bg-zinc-800 rounded-lg"></div>
                     </div>
                     <div className="flex-1 space-y-6">
                        <div className="h-32 bg-indigo-50 dark:bg-indigo-500/10 rounded-2xl border border-indigo-100 dark:border-indigo-500/20 flex items-center p-6">
                           <div className="space-y-3 w-full">
                              <div className="h-4 bg-indigo-200 dark:bg-indigo-500/30 rounded w-1/4"></div>
                              <div className="h-8 bg-indigo-600 dark:bg-indigo-500 rounded w-1/2"></div>
                           </div>
                        </div>
                        <div className="grid grid-cols-2 gap-6">
                           <div className="h-48 bg-zinc-100 dark:bg-zinc-800/50 rounded-2xl"></div>
                           <div className="h-48 bg-zinc-100 dark:bg-zinc-800/50 rounded-2xl"></div>
                        </div>
                     </div>
                  </div>

               </div>
            </div>

         </div>

      </main>

      {/* Feature Grid */}
      <section id="features" className="py-24 bg-white dark:bg-black relative z-20 border-t border-zinc-200 dark:border-zinc-800">
         <div className="max-w-7xl mx-auto px-6">
            <div className="grid md:grid-cols-3 gap-10">
               
               <div className="space-y-4">
                  <div className="w-14 h-14 bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-400 rounded-2xl flex items-center justify-center">
                     <Smartphone size={28} />
                  </div>
                  <h3 className="text-xl font-black">{locale === 'ar' ? 'البطاقات الرقمية للمحفظة' : 'Native Digital Cards'}</h3>
                  <p className="text-zinc-500 font-medium">
                     {locale === 'ar' ? 'يتكامل بالكامل مع Apple Wallet و Google Pay بدون الحاجة لتحميل تطبيقات إضافية.' : 'Fully integrates with Apple Wallet and Google Pay with zero apps required.'}
                  </p>
               </div>

               <div className="space-y-4">
                  <div className="w-14 h-14 bg-fuchsia-100 dark:bg-fuchsia-900/40 text-fuchsia-600 dark:text-fuchsia-400 rounded-2xl flex items-center justify-center">
                     <Globe size={28} />
                  </div>
                  <h3 className="text-xl font-black">{locale === 'ar' ? 'حلول الوكالات البيضاء' : 'White-Label Agency'}</h3>
                  <p className="text-zinc-500 font-medium">
                     {locale === 'ar' ? 'أطلق حلك البرمجي الخاص تحت علامتك التجارية عبر ربط النطاقات والواجهات المخصصة.' : 'Launch your own SaaS under your brand through domain mapping and CNAMEs.'}
                  </p>
               </div>

               <div className="space-y-4">
                  <div className="w-14 h-14 bg-emerald-100 dark:bg-emerald-900/40 text-emerald-600 dark:text-emerald-400 rounded-2xl flex items-center justify-center">
                     <Zap size={28} />
                  </div>
                  <h3 className="text-xl font-black">{locale === 'ar' ? 'أتمتة الرسائل والإشعارات' : 'Push Automations'}</h3>
                  <p className="text-zinc-500 font-medium">
                     {locale === 'ar' ? 'إخطارات شاشة القفل عند الاقتراب من المتجر أو رسائل عيد ميلاد تلقائية مجاناً.' : 'Lock-screen push notifications when near the store or automated birthday alerts for free.'}
                  </p>
               </div>

            </div>
         </div>
      </section>

    </div>
  );
}
