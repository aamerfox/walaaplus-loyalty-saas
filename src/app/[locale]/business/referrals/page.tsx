"use client";

import { useTranslations } from "next-intl";
import { useLocale } from "next-intl";
import { Award, Gift, Link as LinkIcon, Users, ArrowUpRight, Copy, Share2 } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";

export default function ReferralProgramPage() {
  const locale = useLocale();
  const dir = locale === 'ar' ? 'rtl' : 'ltr';

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950 p-6 sm:p-10 font-sans" dir={dir}>
      <div className="max-w-6xl mx-auto space-y-8">
        
        {/* Header */}
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
           <div>
              <h1 className="text-4xl font-black tracking-tight text-zinc-900 dark:text-zinc-100 flex items-center gap-3">
                <Users className="w-10 h-10 text-emerald-600" />
                {locale === 'ar' ? 'برنامج الإحالة (Referrals)' : 'Referral Program'}
              </h1>
              <p className="text-zinc-500 mt-2 text-lg max-w-2xl">
                {locale === 'ar' 
                  ? 'حوّل عملائك إلى مسوقين! امنح العميل مكافأة (مثال: ختم مجاني) عندما يدعو أصدقاءه لتنزيل بطاقة الولاء.' 
                  : 'Turn your customers into promoters! Reward them (e.g. 1 Free Stamp) when they invite friends to install the loyalty card.'}
              </p>
           </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
           
           {/* Settings Panel */}
           <div className="lg:col-span-2 space-y-8">
              <div className="bg-white dark:bg-zinc-900 rounded-[2rem] border border-zinc-200 dark:border-zinc-800 p-8 shadow-sm">
                 <div className="flex justify-between items-center mb-6">
                    <h2 className="text-2xl font-bold text-zinc-900 dark:text-white">
                      {locale === 'ar' ? 'إعدادات المكافأة' : 'Reward Settings'}
                    </h2>
                    {/* Toggle Switch UI */}
                    <div className="w-14 h-8 bg-emerald-500 rounded-full flex items-center p-1 cursor-pointer justify-end shadow-inner">
                       <div className="w-6 h-6 bg-white rounded-full shadow-sm"></div>
                    </div>
                 </div>

                 <div className="space-y-6">
                    <div className="p-6 bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-200 dark:border-emerald-800/30 rounded-2xl flex items-start gap-4">
                       <Gift className="w-8 h-8 text-emerald-600 dark:text-emerald-400 flex-shrink-0" />
                       <div>
                          <h4 className="font-bold text-emerald-900 dark:text-emerald-300 text-lg">
                            {locale === 'ar' ? 'مكافأة المُحيل (الداعي)' : 'Referrer Reward'}
                          </h4>
                          <p className="text-emerald-800/80 dark:text-emerald-400/80 text-sm mt-1 mb-4">
                            {locale === 'ar' ? 'ماذا سيحصل العميل الحالي عندما يقوم صديقه بتثبيت البطاقة؟' : 'What does the current customer get when their friend installs the card?'}
                          </p>
                          <select className="w-full bg-white dark:bg-zinc-950 border border-emerald-200 dark:border-emerald-800 rounded-xl px-4 py-3 font-bold text-emerald-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500">
                            <option>{locale === 'ar' ? 'ختم واحد مجاني (1 Stamp)' : '1 Free Stamp'}</option>
                            <option>{locale === 'ar' ? '2 ختم مجاني' : '2 Free Stamps'}</option>
                            <option>{locale === 'ar' ? '100 نقطة' : '100 Points'}</option>
                            <option>{locale === 'ar' ? 'قسيمة خصم 10%' : '10% Discount Voucher'}</option>
                          </select>
                       </div>
                    </div>

                    <div className="p-6 bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-2xl flex items-start gap-4">
                       <Award className="w-8 h-8 text-indigo-600 dark:text-indigo-400 flex-shrink-0" />
                       <div className="w-full">
                          <h4 className="font-bold text-zinc-900 dark:text-zinc-100 text-lg">
                            {locale === 'ar' ? 'مكافأة الصديق (المدعو)' : 'Friend Reward (Invitee)'}
                          </h4>
                          <p className="text-zinc-500 text-sm mt-1 mb-4">
                            {locale === 'ar' ? 'ما هو الحافز الذي سيشجع الصديق على تنزيل البطاقة؟' : 'What is the incentive for the friend to actually install the card?'}
                          </p>
                          <select className="w-full bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl px-4 py-3 font-bold text-zinc-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500">
                            <option>{locale === 'ar' ? 'ختم ترحيبي مجاني' : '1 Welcome Stamp'}</option>
                            <option>{locale === 'ar' ? 'لا توجد مكافأة استثنائية' : 'Standard Card (No extra reward)'}</option>
                          </select>
                       </div>
                    </div>
                 </div>
              </div>
           </div>

           {/* Metrics Column */}
           <div className="space-y-6">
              <div className="bg-emerald-600 text-white rounded-[2rem] p-8 shadow-lg relative overflow-hidden">
                 <div className="absolute top-0 right-0 -mr-8 -mt-8 opacity-10">
                    <Users className="w-48 h-48" />
                 </div>
                 <div className="relative z-10">
                    <p className="text-emerald-100 font-bold mb-1">
                      {locale === 'ar' ? 'إجمالي البطاقات المحالة' : 'Total Referred Cards'}
                    </p>
                    <div className="text-6xl font-black mb-4">1,248</div>
                    <div className="flex items-center gap-2 bg-emerald-500/50 w-fit px-3 py-1 rounded-lg text-sm font-bold">
                       <ArrowUpRight className="w-4 h-4" />
                       12% {locale === 'ar' ? 'من إجمالي العملاء' : 'of total customer base'}
                    </div>
                 </div>
              </div>

              <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-[2rem] p-8">
                 <h3 className="font-bold text-zinc-900 dark:text-zinc-100 mb-4">
                   {locale === 'ar' ? 'كيف تبدو للعميل؟' : 'How does it look to the customer?'}
                 </h3>
                 <div className="bg-zinc-100 dark:bg-zinc-950 p-4 rounded-xl text-sm text-zinc-600 dark:text-zinc-400 border border-zinc-200 dark:border-zinc-800 shadow-inner space-y-3">
                    <p>
                      {locale === 'ar' ? 'سيجد العميل داخل بطاقة Apple Wallet رابطاً خاصاً به في الوجه الخلفي للبطاقة:' : 'The customer will find their unique referral link on the back of their Apple Wallet card:'}
                    </p>
                    <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 p-3 rounded-lg flex items-center justify-between font-mono text-xs text-indigo-600 truncate gap-2">
                       <span className="truncate">walaaplus.com/ref/c_9281...</span>
                       <Copy className="w-4 h-4 text-zinc-400 flex-shrink-0" />
                    </div>
                 </div>
              </div>
           </div>

        </div>
      </div>
    </div>
  );
}
