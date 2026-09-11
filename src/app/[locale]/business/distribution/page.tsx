"use client";

import { useLocale } from "next-intl";
import { QrCode, Link2, Download, Printer, Share2 } from "lucide-react";

export default function DistributionPage() {
  const locale = useLocale();
  const dir = locale === 'ar' ? 'rtl' : 'ltr';

  const registrationUrl = "https://walaaplus.com/join/c_9281745x";

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950 p-6 sm:p-10 font-sans" dir={dir}>
      <div className="max-w-7xl mx-auto space-y-8">
        <div>
           <h1 className="text-4xl font-black tracking-tight text-zinc-900 dark:text-zinc-100">
             {locale === 'ar' ? 'توزيع ونشر البطاقات (Card Distribution)' : 'Card Distribution'}
           </h1>
           <p className="text-zinc-500 mt-2 text-lg">
             {locale === 'ar' ? 'كيف ترغب بإصدار البطاقات لعملائك؟ عبر طباعة رمز منضدي للمقهى أو عبر رابط انستغرام.' : 'How would you like to distribute your loyalty cards? Offline QR standees or Online Links.'}
           </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
           
           {/* Offline Distribution Matrix */}
           <div className="bg-white dark:bg-zinc-900 rounded-[2.5rem] border border-zinc-200 dark:border-zinc-800 p-8 shadow-xl">
              <div className="flex items-center gap-4 mb-8 pb-6 border-b border-zinc-100 dark:border-zinc-800">
                 <div className="w-16 h-16 bg-blue-50 dark:bg-blue-500/10 text-blue-600 rounded-2xl flex items-center justify-center shadow-inner">
                    <QrCode className="w-8 h-8" />
                 </div>
                 <div>
                    <h2 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">{locale === 'ar' ? 'التوزيع المادي (Offline)' : 'Offline Kiosk'}</h2>
                    <p className="text-zinc-500 dark:text-zinc-400 text-sm mt-1">
                       {locale === 'ar' ? 'توليد ملفات PDF لطباعة الاستاند للمقهى' : 'Generate printable PDF standees'}
                    </p>
                 </div>
              </div>

              <div className="flex justify-center mb-8">
                 <div className="p-4 bg-white border border-zinc-200 shadow-sm rounded-[2rem]">
                    {/* Placeholder, deliberately not a third-party QR service: sending the
                        registration URL to api.qrserver.com would leak it off the server.
                        QR generation lands with real enrollment tokens in Phase 1a. */}
                    <div className="w-48 h-48 flex flex-col items-center justify-center gap-2 border-2 border-dashed border-zinc-300 rounded-2xl text-zinc-400">
                       <QrCode className="w-12 h-12" aria-hidden="true" />
                       <span className="text-xs px-2 text-center break-all">{registrationUrl}</span>
                    </div>
                 </div>
              </div>

              <div className="space-y-4">
                 <button className="w-full py-4 bg-zinc-900 hover:bg-black text-white dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-100 font-bold text-lg rounded-2xl transition-all shadow-lg active:scale-95 flex items-center justify-center gap-2">
                    <Download className="w-5 h-5" />
                    {locale === 'ar' ? 'تحميل كملف PDF للطباعة' : 'Download Print-ready PDF'}
                 </button>
                 <button className="w-full py-4 bg-zinc-100 hover:bg-zinc-200 text-zinc-900 dark:bg-zinc-800 dark:hover:bg-zinc-700 dark:text-white font-bold text-lg rounded-2xl transition-all flex items-center justify-center gap-2 border border-zinc-200 dark:border-zinc-700">
                    <Printer className="w-5 h-5" />
                    {locale === 'ar' ? 'إرسال الملف عبر الإيميل للمطبعة' : 'Email to Print Shop'}
                 </button>
              </div>
           </div>

           {/* Online Distribution Matrix */}
           <div className="bg-white dark:bg-zinc-900 rounded-[2.5rem] border border-zinc-200 dark:border-zinc-800 p-8 shadow-xl flex flex-col justify-between">
              <div>
                 <div className="flex items-center gap-4 mb-8 pb-6 border-b border-zinc-100 dark:border-zinc-800">
                    <div className="w-16 h-16 bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 rounded-2xl flex items-center justify-center shadow-inner">
                       <Link2 className="w-8 h-8" />
                    </div>
                    <div>
                       <h2 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">{locale === 'ar' ? 'التوزيع الرقمي (Online)' : 'Online Distribution'}</h2>
                       <p className="text-zinc-500 dark:text-zinc-400 text-sm mt-1">
                          {locale === 'ar' ? 'روابط مشاركة للسوشال ميديا والرسائل' : 'Share links for Social Media and SMS'}
                       </p>
                    </div>
                 </div>

                 <div className="mb-8">
                    <label className="block text-sm font-bold text-zinc-700 dark:text-zinc-300 mb-3 uppercase tracking-wider">
                      {locale === 'ar' ? 'رابط التسجيل (Share Link)' : 'Registration Link'}
                    </label>
                    <div className="flex items-center gap-2">
                       <input 
                         type="url" 
                         readOnly 
                         value={registrationUrl} 
                         className="flex-1 bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl px-4 py-4 outline-none font-mono text-sm text-zinc-600 dark:text-zinc-400 select-all" 
                         dir="ltr"
                       />
                       <button className="h-[54px] px-6 bg-indigo-600 hover:bg-indigo-700 text-white font-bold rounded-xl transition-all shadow-md active:scale-95 whitespace-nowrap">
                          {locale === 'ar' ? 'نسخ' : 'Copy'}
                       </button>
                    </div>
                 </div>

                 <div className="space-y-4">
                    <p className="text-sm font-bold text-zinc-500 mb-2 uppercase tracking-widest">{locale === 'ar' ? 'إجراءات سريعة' : 'Quick Actions'}</p>
                    <div className="grid grid-cols-2 gap-4">
                       <button className="py-4 bg-[#25D366]/10 text-[#25D366] hover:bg-[#25D366]/20 font-bold rounded-xl transition-colors flex flex-col items-center justify-center gap-2">
                          <Share2 className="w-5 h-5" />
                          <span>WhatsApp</span>
                       </button>
                       <button className="py-4 bg-blue-500/10 text-blue-500 hover:bg-blue-500/20 font-bold rounded-xl transition-colors flex flex-col items-center justify-center gap-2">
                          <Share2 className="w-5 h-5" />
                          <span>Instagram</span>
                       </button>
                    </div>
                 </div>
              </div>

              <div className="mt-8 pt-6 border-t border-zinc-100 dark:border-zinc-800 bg-amber-50 dark:bg-amber-500/10 p-4 rounded-xl flex items-start gap-3">
                 <div className="w-8 h-8 bg-amber-200 dark:bg-amber-500 text-amber-800 dark:text-zinc-900 font-black rounded-full flex items-center justify-center flex-shrink-0">!</div>
                 <p className="text-xs text-amber-800 dark:text-amber-200 font-bold leading-relaxed">
                   {locale === 'ar' ? 'ملاحظة: سيتم طلب رقم الهاتف السوري (+963) من العميل قبل تنزيل البطاقة على Apple Wallet لمنع التزوير وحفظ النقاط في السحابة.' : 'Note: Syrian phone numbers (+963) are required for cloud verification.'}
                 </p>
              </div>
           </div>

        </div>
      </div>
    </div>
  );
}
