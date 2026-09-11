"use client";

import { useLocale } from "next-intl";
import { Bell, MapPin, Gift, AlertCircle } from "lucide-react";

export default function AutomationsPage() {
  const locale = useLocale();
  const dir = locale === 'ar' ? 'rtl' : 'ltr';

  const automations = [
    {
      id: "geofence",
      name: locale === 'ar' ? 'إشعار الدخول عبر الموقع (Geofencing)' : 'Geofencing Push',
      description: locale === 'ar' ? 'إرسال إشعار تلقائي لعملائك عندما يمرون بالقرب من مقهاك بقطر 100 متر (تعمل عبر Apple / Google Wallet).' : 'Send an automated push notification when customers are within 100 meters of your location.',
      icon: MapPin,
      active: true,
      color: "bg-blue-500",
      stats: locale === 'ar' ? 'تم إرسال 142 إشعار اليوم' : '142 Pushes Sent Today'
    },
    {
      id: "birthday",
      name: locale === 'ar' ? 'هدية يوم الميلاد تلقائياً' : 'Automated Birthday Gift',
      description: locale === 'ar' ? 'إرسال تهنئة آلية مع رصيد 5000 ل.س أو كوبون خصم 10% في يوم ميلاد العميل.' : 'Send an automated 10% discount on the customer\'s birthday.',
      icon: Gift,
      active: true,
      color: "bg-rose-500",
      stats: locale === 'ar' ? 'تم الوصول لـ 4 عملاء اليوم' : 'Reached 4 Customers Today'
    },
    {
      id: "winback",
      name: locale === 'ar' ? 'استعادة العملاء (Miss You)' : 'Win-Back (Miss You) Campaign',
      description: locale === 'ar' ? 'إرسال إشعار لمن لم يزر النشاط التجاري منذ أكثر من 30 يوماً لدعوتهم للعودة.' : 'Send a push to customers who haven\'t visited in 30 days.',
      icon: AlertCircle,
      active: false,
      color: "bg-amber-500",
      stats: locale === 'ar' ? 'الحملة متوقفة' : 'Campaign Paused'
    },
    {
      id: "bulk",
      name: locale === 'ar' ? 'إرسال رسائل جماعية للكل' : 'Manual Bulk Push',
      description: locale === 'ar' ? 'إرسال رسالة ترويجية لجميع حاملي البطاقة الرقمية (محدود بـ 2 رسائل شهرياً لتجنب الحظر).' : 'Send a promotional push to all digital card holders.',
      icon: Bell,
      active: false,
      color: "bg-indigo-500",
      stats: locale === 'ar' ? 'متبقي 2 حملات هذا الشهر' : '2 Campaigns Remaining this month'
    }
  ];

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950 p-6 sm:p-10 font-sans" dir={dir}>
      <div className="max-w-7xl mx-auto space-y-8">
        <div>
           <h1 className="text-4xl font-black tracking-tight text-zinc-900 dark:text-zinc-100">
             {locale === 'ar' ? 'محرك الأتمتة الجغرافية والإشعارات' : 'Geofencing & Push Automations'}
           </h1>
           <p className="text-zinc-500 mt-2 text-lg">
             {locale === 'ar' ? 'تواصل مع عملائك تلقائياً وارفع من معدل الاحتفاظ والزيارات المتكررة.' : 'Automate your customer retention with highly targeted Wallet Push Notifications.'}
           </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
           {automations.map((auto) => (
             <div key={auto.id} className="bg-white dark:bg-zinc-900 rounded-[2rem] border border-zinc-200 dark:border-zinc-800 p-8 shadow-sm hover:shadow-lg transition-all flex flex-col justify-between">
                <div className="flex items-start gap-4 mb-6">
                   <div className={`w-14 h-14 rounded-2xl flex items-center justify-center text-white shadow-inner flex-shrink-0 ${auto.color}`}>
                      <auto.icon className="w-6 h-6" />
                   </div>
                   <div className="flex-1">
                      <div className="flex justify-between items-center mb-2">
                         <h2 className="text-xl font-bold text-zinc-900 dark:text-zinc-100">{auto.name}</h2>
                         <button className={`w-12 h-6 rounded-full flex items-center px-1 transition-colors ${auto.active ? 'bg-emerald-500 justify-end' : 'bg-zinc-300 dark:bg-zinc-700 justify-start'}`}>
                            <div className="w-4 h-4 rounded-full bg-white shadow-sm"></div>
                         </button>
                      </div>
                      <p className="text-sm text-zinc-500 dark:text-zinc-400 leading-relaxed">{auto.description}</p>
                   </div>
                </div>

                <div className="mt-4 pt-4 border-t border-zinc-100 dark:border-zinc-800 flex justify-between items-center">
                   <span className="text-sm font-bold text-zinc-400 uppercase tracking-widest">{auto.stats}</span>
                   <button className="text-indigo-600 dark:text-indigo-400 font-bold text-sm hover:underline">
                      {locale === 'ar' ? 'تعديل النص والشروط' : 'Edit Logic & Text'}
                   </button>
                </div>
             </div>
           ))}
        </div>

        {/* Global Geofence Editor */}
        <div className="bg-white dark:bg-zinc-900 rounded-[2.5rem] border border-zinc-200 dark:border-zinc-800 overflow-hidden shadow-xl mt-8">
           <div className="p-8 border-b border-zinc-200 dark:border-zinc-800 flex justify-between items-center bg-zinc-50/50 dark:bg-zinc-900/50">
              <h2 className="text-xl font-bold text-zinc-900 dark:text-zinc-100 flex items-center gap-3">
                 <MapPin className="w-6 h-6 text-indigo-500" />
                 {locale === 'ar' ? 'إعدادات المواقع الجغرافية (Apple/Google Wallet GPS)' : 'GPS Triggers'}
              </h2>
           </div>
           <div className="p-8">
              <div className="space-y-6">
                 <div>
                    <label className="block text-sm font-bold text-zinc-700 dark:text-zinc-300 mb-2 uppercase tracking-wider">
                      {locale === 'ar' ? 'نص الإشعار عند الاقتراب' : 'Geofence Push Text'}
                    </label>
                    <input 
                      type="text" 
                      defaultValue={locale === 'ar' ? "مرحباً! أنت قريب جداً من ولاء بلس. تفضل بزيارتنا واستخدم بطاقتك للحصول على الخصم." : "You're nearby! Drop in and use your loyalty card."} 
                      className="w-full bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl px-4 py-3 outline-none focus:ring-2 focus:ring-indigo-500 transition-all font-medium text-zinc-900 dark:text-white" 
                    />
                 </div>
                 <div className="grid grid-cols-2 gap-6">
                    <div>
                       <label className="block text-sm font-bold text-zinc-700 dark:text-zinc-300 mb-2 uppercase tracking-wider">{locale === 'ar' ? 'خط العرض (Latitude)' : 'Latitude'}</label>
                       <input type="text" defaultValue="33.5138" className="w-full bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl px-4 py-3 text-zinc-900 dark:text-white font-mono" />
                    </div>
                    <div>
                       <label className="block text-sm font-bold text-zinc-700 dark:text-zinc-300 mb-2 uppercase tracking-wider">{locale === 'ar' ? 'خط الطول (Longitude)' : 'Longitude'}</label>
                       <input type="text" defaultValue="36.2765" className="w-full bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl px-4 py-3 text-zinc-900 dark:text-white font-mono" />
                    </div>
                 </div>
                 <button className="w-full py-4 bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-lg rounded-2xl transition-all shadow-lg active:scale-95">
                    {locale === 'ar' ? 'تحديث إحداثيات GPS' : 'Update GPS Coordinates'}
                 </button>
              </div>
           </div>
        </div>
      </div>
    </div>
  );
}
