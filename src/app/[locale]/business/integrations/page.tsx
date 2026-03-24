"use client";

import { useTranslations } from "next-intl";
import { useLocale } from "next-intl";
import { Smartphone, Zap, Webhook, Link2, KeySquare } from "lucide-react";
import { useState } from "react";

export default function IntegrationsPage() {
  const locale = useLocale();
  const dir = locale === 'ar' ? 'rtl' : 'ltr';

  const [provider, setProvider] = useState("syriatel");

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950 p-6 sm:p-10 font-sans" dir={dir}>
      <div className="max-w-7xl mx-auto space-y-8">
        <div>
           <h1 className="text-4xl font-black tracking-tight text-zinc-900 dark:text-zinc-100">
             {locale === 'ar' ? 'الربط البرمجي و بوابة الرسائل (SMS Gateway)' : 'Integrations & Open API'}
           </h1>
           <p className="text-zinc-500 mt-2 text-lg">
             {locale === 'ar' ? 'اربط منصة الولاء بمزود الرسائل المحلي الخاص بك بدلاً من Twilio المحظور لتصل إشعاراتك للسوق السوري مباشرة.' : 'Connect to a local SMS gateway instead of Twilio to ensure message delivery.'}
           </p>
        </div>

        <div className="bg-white dark:bg-zinc-900 rounded-[2.5rem] border border-zinc-200 dark:border-zinc-800 p-8 shadow-xl max-w-3xl">
           <div className="flex items-center gap-4 mb-8 pb-6 border-b border-zinc-100 dark:border-zinc-800">
              <div className="w-16 h-16 bg-blue-50 dark:bg-blue-500/10 text-blue-600 rounded-2xl flex items-center justify-center shadow-inner">
                 <Smartphone className="w-8 h-8" />
              </div>
              <div>
                 <h2 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">{locale === 'ar' ? 'بوابة إرسال الرسائل النصية (Syria SMS)' : 'Local SMS Gateway'}</h2>
                 <p className="text-zinc-500 dark:text-zinc-400 text-sm mt-1">
                    {locale === 'ar' ? 'إرسال الرموز التسويقية وتهاني يوم الميلاد لعملائك عبر مزود سوري محلي.' : 'Configure your local provider for automated SMS campaigns.'}
                 </p>
              </div>
           </div>

           <div className="space-y-6">
              <div>
                 <label className="block text-sm font-bold text-zinc-700 dark:text-zinc-300 mb-3 uppercase tracking-wider">
                   {locale === 'ar' ? 'مزود خدمة الرسائل (SMS Provider)' : 'SMS Provider'}
                 </label>
                 <select 
                   value={provider}
                   onChange={(e) => setProvider(e.target.value)}
                   className="w-full bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl px-4 py-4 outline-none focus:ring-2 focus:ring-indigo-500 font-bold text-zinc-900 dark:text-white"
                 >
                    <option value="syriatel">Syriatel Bulk SMS API</option>
                    <option value="mtn">MTN Syria Corporate API</option>
                    <option value="custom">Custom Webhook (JSON POST)</option>
                 </select>
              </div>

              {provider !== 'custom' && (
                 <>
                    <div>
                       <label className="block text-sm font-bold text-zinc-700 dark:text-zinc-300 mb-3 uppercase tracking-wider">
                         {locale === 'ar' ? 'معرف الخدمة (Sender ID)' : 'Sender ID'}
                       </label>
                       <input type="text" placeholder="WALAA-CAFE" className="w-full bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl px-4 py-3 outline-none focus:ring-2 focus:ring-indigo-500 font-mono" />
                       <p className="text-xs text-zinc-500 mt-2">يجب أن يكون المعرّف موافقاً عليه من الهيئة الناظمة للاتصالات والبريد السورية.</p>
                    </div>

                    <div>
                       <label className="block text-sm font-bold text-zinc-700 dark:text-zinc-300 mb-3 uppercase tracking-wider">API Key (Token)</label>
                       <div className="relative">
                         <KeySquare className="w-5 h-5 absolute start-4 top-3.5 text-zinc-400" />
                         <input type="password" placeholder="••••••••••••••••" className="w-full bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl ps-12 pe-4 py-3 outline-none focus:ring-2 focus:ring-indigo-500 font-mono tracking-widest" dir="ltr" />
                       </div>
                    </div>
                 </>
              )}

              {provider === 'custom' && (
                 <div>
                    <label className="block text-sm font-bold text-zinc-700 dark:text-zinc-300 mb-3 uppercase tracking-wider">Webhook URL Endpoint</label>
                    <div className="relative">
                      <Webhook className="w-5 h-5 absolute start-4 top-3.5 text-zinc-400" />
                      <input type="url" placeholder="https://api.domain.sy/v1/sms/send" className="w-full bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl ps-12 pe-4 py-3 outline-none focus:ring-2 focus:ring-indigo-500 font-mono text-sm" dir="ltr" />
                    </div>
                 </div>
              )}

              <div className="pt-6 border-t border-zinc-100 dark:border-zinc-800 mt-8">
                 <button className="w-full py-4 bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-lg rounded-2xl transition-all shadow-lg active:scale-95">
                    {locale === 'ar' ? 'حفظ إعدادات بوابة الـ SMS' : 'Save SMS Gateway Configuration'}
                 </button>
              </div>
           </div>
        </div>
      </div>
    </div>
  );
}
