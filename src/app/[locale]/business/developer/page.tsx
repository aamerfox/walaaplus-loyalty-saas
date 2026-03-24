"use client";

import { useLocale } from "next-intl";
import { useState } from "react";
import { Copy, Key, Webhook, Fingerprint, Activity, Server, ArrowRight } from "lucide-react";

export default function DeveloperHubPage() {
  const locale = useLocale();
  const dir = locale === 'ar' ? 'rtl' : 'ltr';

  // Static mocked data representing the Boomerangme token state
  const apiKeyPreview = "wp_live_8f7d6a59b4c3e2f1a0d9b8c7e6f5d4a3b2c1";

  // Webhooks Configuration State
  const [webhooks, setWebhooks] = useState({
    cardIssued: { url: "", active: false },
    cardScanned: { url: "https://hook.eu1.make.com/scanned_event_12948", active: true },
    feedbackReceived: { url: "", active: false },
  });

  return (
    <div className="p-4 sm:p-8 min-h-screen bg-zinc-50 dark:bg-zinc-950 font-sans" dir={dir}>
      <div className="max-w-6xl mx-auto">
        
        {/* Header Setup */}
        <div className="mb-10">
           <div className="flex items-center gap-3 mb-4">
              <div className="w-12 h-12 rounded-2xl bg-zinc-200 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 flex items-center justify-center">
                 <Server size={24} />
              </div>
              <div>
                 <h1 className="text-4xl font-black tracking-tight text-zinc-900 dark:text-zinc-100">
                   {locale === 'ar' ? 'المطورين والربط (API & Webhooks)' : 'Developer API & Webhooks'}
                 </h1>
              </div>
           </div>
           <p className="text-zinc-500 mt-2 text-lg font-medium">
             {locale === 'ar' 
                ? 'اربط نظام ولاء بلس مع أكثر من 5000 تطبيق عبر Zapier أو Make لاضافة أتمتة لجميع أحداث الولاء الخاصة بك.' 
                : 'Connect WalaaPlus with over 5,000 apps via Zapier or Make to automate your business ecosystem.'}
           </p>
        </div>

        <div className="space-y-10">
           
           {/* Section 1: Bearer API Key */}
           <div className="bg-white dark:bg-zinc-900 rounded-[2.5rem] border border-zinc-200 dark:border-zinc-800 overflow-hidden shadow-xl">
              <div className="p-8 pb-0">
                 <div className="flex items-center gap-3 mb-2">
                    <Key size={24} className="text-indigo-600 dark:text-indigo-400" />
                    <h2 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">
                       {locale === 'ar' ? 'مفتاح الربط البرمجي (Static API Key)' : 'Static API Key'}
                    </h2>
                 </div>
                 <p className="text-zinc-500 font-medium text-sm mb-6">
                   {locale === 'ar' 
                      ? 'لا تشارك هذا المفتاح أبداً، امنحه فقط لمنصات الربط الموثوقة كـ Zapier أو لفريق المطورين الخاص بك.' 
                      : 'Never share this token publicly. Use this Bearer Token to authenticate directly with our endpoints.'}
                 </p>
              </div>

              <div className="p-8 pt-4">
                 <div className="relative group">
                    <div className="absolute inset-y-0 start-0 flex items-center ps-5 pointer-events-none">
                       <Fingerprint className="text-zinc-400" size={20} />
                    </div>
                    <input 
                       type="text" 
                       readOnly 
                       value={apiKeyPreview} 
                       className="block w-full p-4 ps-14 text-sm text-zinc-900 font-mono font-bold bg-zinc-50 rounded-2xl border border-zinc-200 focus:ring-indigo-500 focus:border-indigo-500 dark:bg-zinc-950 dark:border-zinc-800 dark:text-white"
                    />
                    <button className="absolute inset-y-2 end-2 bg-indigo-600 hover:bg-indigo-700 text-white font-bold rounded-xl px-4 py-2 text-sm flex items-center gap-2 transition-colors">
                       <Copy size={16} />
                       {locale === 'ar' ? 'نسخ المفتاح' : 'Copy Key'}
                    </button>
                 </div>
                 
                 <div className="mt-6 flex flex-wrap gap-4">
                    <button className="bg-orange-500/10 text-orange-600 dark:text-orange-400 font-bold px-6 py-3 rounded-xl border border-orange-200 dark:border-orange-500/20 flex items-center gap-2">
                       {locale === 'ar' ? 'تطبيق Zapier' : 'Zapier Integration'} <ArrowRight size={16} className={locale === 'ar' ? 'rotate-180' : ''} />
                    </button>
                    <button className="bg-purple-500/10 text-purple-600 dark:text-purple-400 font-bold px-6 py-3 rounded-xl border border-purple-200 dark:border-purple-500/20 flex items-center gap-2">
                       {locale === 'ar' ? 'تطبيق Make / Integromat' : 'Make App Node'} <ArrowRight size={16} className={locale === 'ar' ? 'rotate-180' : ''} />
                    </button>
                 </div>
              </div>
           </div>

           {/* Section 2: Outgoing Webhooks */}
           <div className="bg-white dark:bg-zinc-900 rounded-[2.5rem] border border-zinc-200 dark:border-zinc-800 p-8 shadow-xl">
              <div className="flex items-center gap-3 mb-2">
                 <Webhook size={24} className="text-emerald-600 dark:text-emerald-400" />
                 <h2 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">
                    {locale === 'ar' ? 'الويب هوك الصادر (Outgoing Webhooks)' : 'Outgoing Event Webhooks'}
                 </h2>
              </div>
              <p className="text-zinc-500 font-medium text-sm mb-8">
                {locale === 'ar' 
                   ? 'أدخل روابط الاستماع (Catch Hooks) الخاصة بك ليتم إرسال الحدث إلى خادمك في الزمن الحقيقي حين حدوثه.' 
                   : 'Enter your Catch Hook URLs. We will fire a POST payload in real-time when the event occurs.'}
              </p>

              <div className="space-y-6">
                 
                 {/* Webhook 1 */}
                 <div className="bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-2xl p-6 transition-colors focus-within:border-emerald-500/50">
                    <div className="flex items-center justify-between mb-4">
                       <div className="flex items-center gap-2">
                          <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
                          <span className="font-bold text-zinc-900 dark:text-zinc-100 uppercase tracking-widest text-xs">event.card.issued</span>
                       </div>
                       <label className="relative inline-flex items-center cursor-pointer">
                         <input type="checkbox" className="sr-only peer" checked={false} />
                         <div className="w-11 h-6 bg-zinc-200 peer-focus:outline-none rounded-full peer dark:bg-zinc-800 peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-zinc-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-zinc-600 peer-checked:bg-emerald-500"></div>
                       </label>
                    </div>
                    <div>
                       <label className="block text-sm font-bold text-zinc-700 dark:text-zinc-300 mb-2">
                         {locale === 'ar' ? 'عند إصدار بطاقة جديدة وعميل جديد:' : 'Fired when a new card is issued:'}
                       </label>
                       <input type="text" placeholder="https://..." className="w-full bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl px-4 py-3 text-sm font-mono text-zinc-600 outline-none focus:ring-2 focus:ring-emerald-500" />
                    </div>
                 </div>

                 {/* Webhook 2 */}
                 <div className="bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-2xl p-6 transition-colors focus-within:border-emerald-500/50">
                    <div className="flex items-center justify-between mb-4">
                       <div className="flex items-center gap-2">
                          <span className="w-2 h-2 rounded-full bg-emerald-500"></span>
                          <span className="font-bold text-zinc-900 dark:text-zinc-100 uppercase tracking-widest text-xs">event.card.scanned</span>
                       </div>
                       <label className="relative inline-flex items-center cursor-pointer">
                         <input type="checkbox" className="sr-only peer" checked={true} />
                         <div className="w-11 h-6 bg-zinc-200 peer-focus:outline-none rounded-full peer dark:bg-zinc-800 peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-zinc-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-zinc-600 peer-checked:bg-emerald-500"></div>
                       </label>
                    </div>
                    <div>
                       <label className="block text-sm font-bold text-zinc-700 dark:text-zinc-300 mb-2">
                         {locale === 'ar' ? 'عند منح أختام/نقاط لمسح البطاقة:' : 'Fired when stamps/cashback are awarded or deducted:'}
                       </label>
                       <div className="relative">
                          <input type="text" value={webhooks.cardScanned.url} readOnly className="w-full bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-200 dark:border-emerald-500/30 rounded-xl px-4 py-3 text-sm font-mono text-emerald-900 dark:text-emerald-400 outline-none" />
                          <div className="absolute inset-y-0 end-3 flex items-center">
                             <span className="bg-emerald-200 text-emerald-800 text-[10px] px-2 py-0.5 rounded font-black uppercase tracking-widest">{locale === 'ar' ? 'مفعل' : 'Active'}</span>
                          </div>
                       </div>
                    </div>
                 </div>

                 {/* Webhook 3 */}
                 <div className="bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-2xl p-6 transition-colors focus-within:border-emerald-500/50">
                    <div className="flex items-center justify-between mb-4">
                       <div className="flex items-center gap-2">
                          <span className="w-2 h-2 rounded-full bg-zinc-300 dark:bg-zinc-700"></span>
                          <span className="font-bold text-zinc-900 dark:text-zinc-100 uppercase tracking-widest text-xs">event.feedback.received</span>
                       </div>
                       <label className="relative inline-flex items-center cursor-pointer">
                         <input type="checkbox" className="sr-only peer" checked={false} />
                         <div className="w-11 h-6 bg-zinc-200 peer-focus:outline-none rounded-full peer dark:bg-zinc-800 peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-zinc-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-zinc-600 peer-checked:bg-emerald-500"></div>
                       </label>
                    </div>
                    <div>
                       <label className="block text-sm font-bold text-zinc-700 dark:text-zinc-300 mb-2">
                         {locale === 'ar' ? 'عند ترك العميل تقييماً جديداً (NPS):' : 'Fired when a customer submits a 1-5 star review:'}
                       </label>
                       <input type="text" placeholder="https://..." className="w-full bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl px-4 py-3 text-sm font-mono text-zinc-600 outline-none focus:ring-2 focus:ring-emerald-500" />
                    </div>
                 </div>

              </div>
              
              <div className="mt-8 flex justify-end">
                 <button className="bg-emerald-600 hover:bg-emerald-700 text-white px-8 py-3 rounded-xl font-black text-lg shadow-lg shadow-emerald-600/20 active:scale-95 transition-transform flex items-center gap-2">
                    <Activity size={20} />
                    {locale === 'ar' ? 'حفظ واختبار الروابط' : 'Save & Ping Webhooks'}
                 </button>
              </div>

           </div>

        </div>
      </div>
    </div>
  );
}
