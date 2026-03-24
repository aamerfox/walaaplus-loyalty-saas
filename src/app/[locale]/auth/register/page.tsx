"use client";

import { useLocale } from "next-intl";
import { Link } from "@/i18n/routing";
import { ArrowLeft, Building2, Store } from "lucide-react";

export default function RegisterPage() {
  const locale = useLocale();
  const dir = locale === 'ar' ? 'rtl' : 'ltr';

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950 font-sans flex text-zinc-900 dark:text-zinc-50" dir={dir}>
      
      {/* Visual Splash Panel (Hidden on Mobile) */}
      <div className="hidden lg:flex w-[45%] bg-indigo-600 relative overflow-hidden flex-col justify-between p-12">
         {/* Abstract Shapes */}
         <div className="absolute top-0 right-0 w-96 h-96 bg-white/10 rounded-full blur-3xl -translate-y-1/2 translate-x-1/2"></div>
         <div className="absolute bottom-0 left-0 w-96 h-96 bg-rose-500/20 rounded-full blur-3xl translate-y-1/2 -translate-x-1/2"></div>
         
         <div className="relative z-10">
            <Link href="/" className="flex items-center gap-3">
               <div className="w-12 h-12 rounded-2xl bg-white flex items-center justify-center shadow-lg">
                  <span className="text-indigo-600 font-black text-2xl">W</span>
               </div>
               <span className="font-black text-2xl tracking-tighter text-white">WalaaPlus</span>
            </Link>
         </div>

         <div className="relative z-10 text-white max-w-md">
            <h2 className="text-4xl font-black mb-6 leading-[1.2]">
               {locale === 'ar' ? 'ابدأ في بناء جيش من العملاء المخلصين لعلامتك.' : 'Start building an army of loyal customers.'}
            </h2>
            <p className="text-indigo-200 text-lg font-medium leading-relaxed">
               {locale === 'ar' 
                  ? 'انضم إلى منصة الولاء الأسرع نمواً في الشرق الأوسط. إطلاق محفظتك الرقمية لا يستغرق سوى دقيقتين.' 
                  : 'Join the fastest growing loyalty ecosystem. Launch your digital cards globally in just under 2 minutes.'}
            </p>
         </div>
      </div>

      {/* Registration Form Panel */}
      <div className="flex-1 flex flex-col justify-center p-6 sm:p-12 relative">
         
         <Link href="/" className="absolute top-8 start-8 flex items-center gap-2 text-zinc-500 hover:text-zinc-900 dark:hover:text-white font-bold text-sm bg-white dark:bg-zinc-900 px-4 py-2 rounded-full border border-zinc-200 dark:border-zinc-800 shadow-sm transition-all hover:scale-105">
            <ArrowLeft size={16} className={locale === 'ar' ? 'rotate-180' : ''} />
            {locale === 'ar' ? 'العودة' : 'Back'}
         </Link>

         <div className="max-w-md mx-auto w-full">
            <div className="mb-8 mt-12">
               <h1 className="text-3xl font-black mb-2">
                  {locale === 'ar' ? 'إنشاء حساب جديد' : 'Create an Account'}
               </h1>
               <p className="text-zinc-500 font-medium">
                  {locale === 'ar' ? 'هل أنت صاحب عمل تجاري أم وكالة تسويق؟' : 'Are you a local business or a marketing agency?'}
               </p>
            </div>

            <form className="space-y-6">

               {/* Account Type Selector */}
               <div className="grid grid-cols-2 gap-4">
                  <label className="cursor-pointer relative">
                     <input type="radio" name="account_type" className="peer sr-only" defaultChecked />
                     <div className="border-2 border-zinc-200 dark:border-zinc-800 rounded-2xl p-4 text-center hover:bg-zinc-50 dark:hover:bg-zinc-900 peer-checked:border-indigo-600 peer-checked:bg-indigo-50 dark:peer-checked:bg-indigo-500/10 transition-colors">
                        <Store size={24} className="mx-auto mb-2 text-zinc-400 peer-checked:text-indigo-600" />
                        <div className="font-bold text-sm">{locale === 'ar' ? 'متجر محلي' : 'Local Business'}</div>
                     </div>
                  </label>
                  <label className="cursor-pointer relative">
                     <input type="radio" name="account_type" className="peer sr-only" />
                     <div className="border-2 border-zinc-200 dark:border-zinc-800 rounded-2xl p-4 text-center hover:bg-zinc-50 dark:hover:bg-zinc-900 peer-checked:border-indigo-600 peer-checked:bg-indigo-50 dark:peer-checked:bg-indigo-500/10 transition-colors">
                        <Building2 size={24} className="mx-auto mb-2 text-zinc-400 peer-checked:text-indigo-600" />
                        <div className="font-bold text-sm">{locale === 'ar' ? 'وكالة تسويق (SaaS)' : 'Agency'}</div>
                     </div>
                  </label>
               </div>

               <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                     <label className="text-xs font-bold uppercase tracking-wider text-zinc-500">
                        {locale === 'ar' ? 'الاسم الأول' : 'First Name'}
                     </label>
                     <input type="text" className="w-full bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-indigo-500 outline-none transition-all dark:text-white" />
                  </div>
                  <div className="space-y-2">
                     <label className="text-xs font-bold uppercase tracking-wider text-zinc-500">
                        {locale === 'ar' ? 'اسم العائلة' : 'Last Name'}
                     </label>
                     <input type="text" className="w-full bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-indigo-500 outline-none transition-all dark:text-white" />
                  </div>
               </div>

               <div className="space-y-2">
                  <label className="text-xs font-bold uppercase tracking-wider text-zinc-500">
                     {locale === 'ar' ? 'اسم العمل التجاري / الوكالة' : 'Business / Agency Name'}
                  </label>
                  <input type="text" className="w-full bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-indigo-500 outline-none transition-all dark:text-white" />
               </div>

               <div className="space-y-2">
                  <label className="text-xs font-bold uppercase tracking-wider text-zinc-500">
                     {locale === 'ar' ? 'البريد الإلكتروني' : 'Work Email'}
                  </label>
                  <input type="email" placeholder="name@company.com" className="w-full bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-indigo-500 outline-none transition-all dark:text-white" />
               </div>

               <div className="space-y-2">
                  <label className="text-xs font-bold uppercase tracking-wider text-zinc-500">
                     {locale === 'ar' ? 'كلمة المرور' : 'Password'}
                  </label>
                  <input type="password" placeholder="••••••••" className="w-full bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-indigo-500 outline-none transition-all dark:text-white" />
               </div>

               <div className="pt-4">
                  <Link href="/business" className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-4 rounded-xl flex justify-center items-center shadow-lg shadow-indigo-600/20 transition-transform active:scale-95 text-lg">
                     {locale === 'ar' ? 'سجل حسابك وانطلق' : 'Create Account'}
                  </Link>
                  <p className="text-xs font-bold text-zinc-400 text-center mt-4">
                     {locale === 'ar' ? 'بالتسجيل أنت توافق على شروط الخدمة لبرنامج WalaaPlus' : 'By signing up, you agree to the Terms of Service'}
                  </p>
               </div>

            </form>

            <div className="mt-8 text-center pt-8 border-t border-zinc-200 dark:border-zinc-800">
               <p className="text-sm font-medium text-zinc-500">
                  {locale === 'ar' ? 'لديك حساب بالفعل؟' : "Already have an account?"}{' '}
                  <Link href="/auth/login" className="text-indigo-600 font-bold hover:underline">
                     {locale === 'ar' ? 'سجل الدخول الآن' : 'Sign in'}
                  </Link>
               </p>
            </div>

         </div>
      </div>

    </div>
  );
}
