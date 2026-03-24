"use client";

import { useTranslations } from "next-intl";
import { useLocale } from "next-intl";
import { Bell, Megaphone, Zap, Clock, Send, Plus, Filter, AlertCircle } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";

export default function PushNotificationsPage() {
  const locale = useLocale();
  const dir = locale === 'ar' ? 'rtl' : 'ltr';
  const [activeTab, setActiveTab] = useState<'manual' | 'auto'>('manual');

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950 p-6 sm:p-10 font-sans" dir={dir}>
      <div className="max-w-6xl mx-auto space-y-8">
        
        {/* Header */}
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
           <div>
              <h1 className="text-4xl font-black tracking-tight text-zinc-900 dark:text-zinc-100 flex items-center gap-3">
                <Bell className="w-10 h-10 text-indigo-600" />
                {locale === 'ar' ? 'الإشعارات والأتمتة' : 'Push & Automations'}
              </h1>
              <p className="text-zinc-500 mt-2 text-lg max-w-2xl">
                {locale === 'ar' 
                  ? 'أرسل إشعارات Push مباشرة إلى شاشات هواتف عملائك (Apple/Google Wallet) أو قم بأتمتة الرسائل الترويجية.' 
                  : 'Send direct Push notifications to lock screens (Apple/Google Wallet) or automate promotional messages.'}
              </p>
           </div>
        </div>

        {/* Tab System */}
        <div className="flex gap-2 p-1 bg-zinc-200/50 dark:bg-zinc-800/50 rounded-2xl w-fit">
           <button 
             onClick={() => setActiveTab('manual')}
             className={cn(
               "px-6 py-2.5 rounded-xl font-bold text-sm transition-all flex items-center gap-2",
               activeTab === 'manual' ? "bg-white dark:bg-zinc-900 text-indigo-600 shadow-sm" : "text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
             )}
           >
             <Megaphone className="w-4 h-4" />
             {locale === 'ar' ? 'إرسال يدوي' : 'Manual Broadcast'}
           </button>
           <button 
             onClick={() => setActiveTab('auto')}
             className={cn(
               "px-6 py-2.5 rounded-xl font-bold text-sm transition-all flex items-center gap-2",
               activeTab === 'auto' ? "bg-white dark:bg-zinc-900 text-indigo-600 shadow-sm" : "text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
             )}
           >
             <Zap className="w-4 h-4" />
             {locale === 'ar' ? 'الأتمتة التلقائية' : 'Automations'}
           </button>
        </div>

        {/* Content Area */}
        {activeTab === 'manual' ? (
           <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
              {/* Manual Broadcast Form */}
              <div className="bg-white dark:bg-zinc-900 rounded-[2rem] border border-zinc-200 dark:border-zinc-800 p-8 shadow-sm">
                 <h2 className="text-2xl font-bold text-zinc-900 dark:text-white mb-6">
                    {locale === 'ar' ? 'تأليف الإشعار' : 'Compose Notification'}
                 </h2>
                 
                 <div className="space-y-6">
                    <div>
                       <label className="block text-sm font-bold text-zinc-700 dark:text-zinc-300 mb-2">
                         {locale === 'ar' ? 'عنوان الإشعار' : 'Push Title'}
                       </label>
                       <input 
                         type="text" 
                         placeholder={locale === 'ar' ? 'مثال: عرض خاص اليوم!' : 'e.g., Special Offer Today!'}
                         className="w-full bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                       />
                    </div>
                    <div>
                       <label className="block text-sm font-bold text-zinc-700 dark:text-zinc-300 mb-2">
                         {locale === 'ar' ? 'نص الإشعار' : 'Push Message'}
                       </label>
                       <textarea 
                         rows={4}
                         placeholder={locale === 'ar' ? 'اكتب الرسالة التي ستظهر على شاشة القفل...' : 'Type the message that will appear on the lock screen...'}
                         className="w-full bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none"
                       />
                    </div>
                    
                    <div className="bg-indigo-50 dark:bg-indigo-500/10 border border-indigo-100 dark:border-indigo-500/20 p-4 rounded-xl flex items-start gap-3">
                       <Filter className="w-5 h-5 text-indigo-600 mt-0.5" />
                       <div>
                         <p className="font-bold text-indigo-900 dark:text-indigo-300">
                           {locale === 'ar' ? 'الاستهداف' : 'Targeting'}
                         </p>
                         <p className="text-sm text-indigo-700 dark:text-indigo-400 mt-1">
                           {locale === 'ar' ? 'سيتم إرسال هذا الإشعار إلى جميع العملاء (128 عميل) الذين ثبتوا البطاقة.' : 'Will be sent to all customers (128) who have installed the card.'}
                         </p>
                       </div>
                    </div>

                    <button className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-4 rounded-xl flex items-center justify-center gap-2 transition-all">
                       <Send className="w-5 h-5" />
                       {locale === 'ar' ? 'إرسال الإشعار الآن' : 'Send Broadcast Now'}
                    </button>
                 </div>
              </div>

              {/* iOS Preview */}
              <div className="flex justify-center items-center bg-zinc-100 dark:bg-black rounded-[2rem] p-8 border border-zinc-200 dark:border-zinc-800">
                 {/* Fake iPhone Lock Screen */}
                 <div className="w-[300px] h-[600px] bg-zinc-900 rounded-[3rem] border-8 border-zinc-800 relative overflow-hidden flex flex-col items-center pt-10 shadow-2xl">
                    <div className="absolute top-0 w-32 h-6 bg-zinc-800 rounded-b-3xl"></div>
                    <div className="text-white/80 text-6xl font-extralight mb-8 mt-4 tracking-tighter">09:41</div>
                    
                    {/* The Push Notification UI */}
                    <div className="w-[90%] bg-zinc-800/80 backdrop-blur-xl rounded-2xl p-4 flex gap-3 mt-4">
                       <div className="w-10 h-10 bg-indigo-600 rounded-lg flex items-center justify-center flex-shrink-0">
                         <span className="text-white font-bold">W</span>
                       </div>
                       <div className="flex-1 min-w-0">
                          <div className="flex justify-between items-center mb-1">
                            <span className="font-semibold text-white text-sm">WalaaPlus</span>
                            <span className="text-zinc-400 text-xs">الآن</span>
                          </div>
                          <p className="text-white font-bold text-sm truncate">
                            {locale === 'ar' ? 'عرض خاص اليوم!' : 'Special Offer Today!'}
                          </p>
                          <p className="text-zinc-300 text-sm line-clamp-2 mt-0.5 leading-snug">
                            {locale === 'ar' ? 'لا تفوت الخصم بمناسبة العيد، احصل على 20% خصم على زيارتك القادمة!' : 'Don\'t miss our holiday discount! Get 20% off your next visit!'}
                          </p>
                       </div>
                    </div>
                 </div>
              </div>
           </div>
        ) : (
           <div className="space-y-6">
              {/* Automations List */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                 
                 {/* Birthday Rule */}
                 <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 p-6 rounded-[2rem] relative overflow-hidden group">
                    <div className="flex justify-between items-start mb-4">
                       <div className="w-12 h-12 bg-rose-50 dark:bg-rose-500/10 text-rose-600 rounded-xl flex items-center justify-center">
                          < Zap className="w-6 h-6" />
                       </div>
                       <div className="w-14 h-8 bg-zinc-100 dark:bg-zinc-800 rounded-full flex items-center p-1 cursor-pointer">
                          <div className="w-6 h-6 bg-white dark:bg-zinc-600 rounded-full shadow-sm"></div>
                       </div>
                    </div>
                    <h3 className="text-xl font-bold text-zinc-900 dark:text-zinc-100 mb-2">
                       {locale === 'ar' ? 'إشعار عيد الميلاد' : 'Birthday Trigger'}
                    </h3>
                    <p className="text-zinc-500 text-sm mb-4">
                       {locale === 'ar' ? 'إرسال إشعار لمنح العميل ختم مجاني في يوم ميلاده لزيادة الولاء.' : 'Send a push notification with a free stamp on the customer\'s birthday.'}
                    </p>
                    <div className="flex items-center gap-2 text-xs font-bold text-zinc-400 bg-zinc-50 dark:bg-zinc-950 w-fit px-3 py-1.5 rounded-lg border border-zinc-100 dark:border-zinc-800">
                       <Clock className="w-3.5 h-3.5" />
                       {locale === 'ar' ? 'تُنفذ يومياً الساعة 10 صباحاً' : 'Runs daily at 10 AM'}
                    </div>
                 </div>

                 {/* Sleeping Customer Rule */}
                 <div className="bg-white dark:bg-zinc-900 border border-indigo-200 dark:border-indigo-800 p-6 rounded-[2rem] relative overflow-hidden group shadow-md shadow-indigo-500/5">
                    <div className="flex justify-between items-start mb-4">
                       <div className="w-12 h-12 bg-indigo-50 dark:bg-indigo-500/10 text-indigo-600 rounded-xl flex items-center justify-center">
                          < Zap className="w-6 h-6" />
                       </div>
                       <div className="w-14 h-8 bg-indigo-600 rounded-full flex items-center p-1 cursor-pointer justify-end">
                          <div className="w-6 h-6 bg-white rounded-full shadow-sm"></div>
                       </div>
                    </div>
                    <h3 className="text-xl font-bold text-zinc-900 dark:text-zinc-100 mb-2">
                       {locale === 'ar' ? 'استعادة العملاء (Sleeping)' : 'Win-back Sleeping'}
                    </h3>
                    <p className="text-zinc-500 text-sm mb-4">
                       {locale === 'ar' ? 'إرسال إشعار تلقائي للعملاء الذين لم يزوروا الفرع منذ 30 يوماً.' : 'Auto-send absolute retention ping if no visit in 30 days.'}
                    </p>
                    <div className="flex items-center gap-2 text-xs font-bold text-zinc-400 bg-zinc-50 dark:bg-zinc-950 w-fit px-3 py-1.5 rounded-lg border border-zinc-100 dark:border-zinc-800">
                       <Clock className="w-3.5 h-3.5" />
                       {locale === 'ar' ? 'تُنفذ تلقائياً (نشط)' : 'Runs automatically (Active)'}
                    </div>
                 </div>

              </div>
              
              <button className="w-full bg-zinc-50 hover:bg-zinc-100 dark:bg-zinc-900 hover:dark:bg-zinc-800 border-2 border-dashed border-zinc-200 dark:border-zinc-800 rounded-[2rem] p-6 flex flex-col items-center justify-center text-zinc-500 hover:text-indigo-600 transition-colors">
                 <Plus className="w-8 h-8 mb-2" />
                 <span className="font-bold">{locale === 'ar' ? 'إنشاء قاعدة أتمتة جديدة' : 'Create Custom Rule'}</span>
              </button>
           </div>
        )}

      </div>
    </div>
  );
}
