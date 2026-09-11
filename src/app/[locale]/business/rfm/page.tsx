"use client";

import { useLocale } from "next-intl";
import { PieChart, Activity, TrendingUp, Users, HeartHandshake, AlertTriangle, Moon } from "lucide-react";

export default function RFMAnalysisPage() {
  const locale = useLocale();
  const dir = locale === 'ar' ? 'rtl' : 'ltr';

  const segments = [
    {
      id: "champions",
      name: locale === 'ar' ? 'الأبطال (Champions)' : 'Champions',
      description: locale === 'ar' ? 'اشتروا مؤخراً وبشكل متكرر وأنفقوا أكثر من البقية.' : 'Bought recently, buy often and spend the most.',
      count: 42,
      percent: 12,
      color: "bg-emerald-500",
      textColor: "text-emerald-500",
      bgColor: "bg-emerald-50 dark:bg-emerald-500/10",
      icon: TrendingUp,
      action: locale === 'ar' ? 'كافئهم للترويج لك' : 'Reward them'
    },
    {
      id: "loyal",
      name: locale === 'ar' ? 'المخلصون (Loyal Customers)' : 'Loyal Customers',
      description: locale === 'ar' ? 'ينفقون بشكل جيد وبشكل متكرر بمرور الوقت.' : 'Spend good money and often.',
      count: 128,
      percent: 38,
      color: "bg-indigo-500",
      textColor: "text-indigo-500",
      bgColor: "bg-indigo-50 dark:bg-indigo-500/10",
      icon: HeartHandshake,
      action: locale === 'ar' ? 'بيع منتجات أعلى قيمة (Upsell)' : 'Upsell higher value products'
    },
    {
      id: "atrisk",
      name: locale === 'ar' ? 'في خطر (At Risk)' : 'At Risk',
      description: locale === 'ar' ? 'أنفقوا الكثير، وتكرروا، لكن منذ وقت طويل.' : 'Spent big money, purchased often, but long time ago.',
      count: 56,
      percent: 17,
      color: "bg-amber-500",
      textColor: "text-amber-500",
      bgColor: "bg-amber-50 dark:bg-amber-500/10",
      icon: AlertTriangle,
      action: locale === 'ar' ? 'إرسال اتصالات مخصصة لاستعادتهم' : 'Send personalized win-back emails'
    },
    {
      id: "sleeping",
      name: locale === 'ar' ? 'النائمون (Sleeping)' : 'Sleeping',
      description: locale === 'ar' ? 'أنظمة الزيارة منخفضة جداً ولم يأتوا منذ أشهر.' : 'Low frequency and haven\'t visited in months.',
      count: 110,
      percent: 33,
      color: "bg-rose-500",
      textColor: "text-rose-500",
      bgColor: "bg-rose-50 dark:bg-rose-500/10",
      icon: Moon,
      action: locale === 'ar' ? 'إرسال حملة (اشتقنالك) مع خصم جذري' : 'Send massive discount to revive'
    }
  ];

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950 p-6 sm:p-10 font-sans" dir={dir}>
      <div className="max-w-7xl mx-auto space-y-8">
        <div>
           <h1 className="text-4xl font-black tracking-tight text-zinc-900 dark:text-zinc-100">
             {locale === 'ar' ? 'تحليل سلوك العملاء (RFM Analysis)' : 'RFM Analysis'}
           </h1>
           <p className="text-zinc-500 mt-2 text-lg">
             {locale === 'ar' ? 'تصنيف العملاء بناءً على: متى كانت آخر زيارة؟ كم مرة يزورون؟ وكم ينفقون؟ لمعرفة أفضل عملائك الحقيقيين.' : 'Segment customers by Recency, Frequency, and Monetary value to identify your true VIPs.'}
           </p>
        </div>

        {/* Global Stats */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
           <div className="bg-white dark:bg-zinc-900 rounded-[2.5rem] border border-zinc-200 dark:border-zinc-800 p-8 shadow-sm">
              <div className="flex items-center gap-4 mb-4 text-zinc-500">
                 <Activity className="w-6 h-6" />
                 <h3 className="font-bold text-sm uppercase tracking-widest">{locale === 'ar' ? 'نقاط الحداثة (Recency)' : 'Recency Score'}</h3>
              </div>
              <p className="text-3xl font-black text-zinc-900 dark:text-white" dir="ltr">14 <span className="text-base text-zinc-500 font-medium">Days Avg</span></p>
           </div>
           <div className="bg-white dark:bg-zinc-900 rounded-[2.5rem] border border-zinc-200 dark:border-zinc-800 p-8 shadow-sm">
              <div className="flex items-center gap-4 mb-4 text-zinc-500">
                 <PieChart className="w-6 h-6" />
                 <h3 className="font-bold text-sm uppercase tracking-widest">{locale === 'ar' ? 'نقاط التكرار (Frequency)' : 'Frequency Score'}</h3>
              </div>
              <p className="text-3xl font-black text-zinc-900 dark:text-white" dir="ltr">4.2 <span className="text-base text-zinc-500 font-medium">Visits/Mo</span></p>
           </div>
           <div className="bg-white dark:bg-zinc-900 rounded-[2.5rem] border border-zinc-200 dark:border-zinc-800 p-8 shadow-sm">
              <div className="flex items-center gap-4 mb-4 text-zinc-500">
                 <Users className="w-6 h-6" />
                 <h3 className="font-bold text-sm uppercase tracking-widest">{locale === 'ar' ? 'نقاط القيمة (Monetary)' : 'Monetary Score'}</h3>
              </div>
              <p className="text-3xl font-black text-emerald-600" dir="ltr">185,000 <span className="text-base text-zinc-500 font-medium">SYP LTV</span></p>
           </div>
        </div>

        {/* Segments Matrix */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
           {segments.map((segment) => (
             <div key={segment.id} className="bg-white dark:bg-zinc-900 rounded-[2.5rem] border border-zinc-200 dark:border-zinc-800 p-8 shadow-xl flex flex-col justify-between hover:scale-[1.01] transition-transform">
                <div className="flex items-start justify-between mb-6">
                   <div className="flex items-center gap-4">
                      <div className={`w-14 h-14 rounded-full flex items-center justify-center ${segment.bgColor} ${segment.textColor}`}>
                         <segment.icon className="w-7 h-7" />
                      </div>
                      <div>
                         <h2 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">{segment.name}</h2>
                         <p className="text-zinc-500 text-sm mt-1 max-w-[200px] leading-relaxed">{segment.description}</p>
                      </div>
                   </div>
                   <div className="text-end">
                      <div className="text-3xl font-black text-zinc-900 dark:text-white">{segment.percent}%</div>
                      <div className="text-xs font-bold text-zinc-400 uppercase tracking-widest mt-1">
                         {segment.count} {locale === 'ar' ? 'عميل' : 'Users'}
                      </div>
                   </div>
                </div>

                <div className="mt-4 pt-6 border-t border-zinc-100 dark:border-zinc-800">
                   <p className="text-sm font-bold text-zinc-500 mb-4">{locale === 'ar' ? 'الإجراء المقترح:' : 'Recommended Action:'}</p>
                   <button className={`w-full py-4 text-white font-bold text-lg rounded-2xl transition-all shadow-md active:scale-95 ${segment.color} hover:brightness-110`}>
                      {segment.action}
                   </button>
                </div>
             </div>
           ))}
        </div>
      </div>
    </div>
  );
}
