"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { useLocale } from "next-intl";

type CardType = 'STAMP' | 'CASHBACK' | 'DISCOUNT' | 'SUBSCRIPTION' | 'GIFT' | 'COUPON';

export default function CardBuilder() {
  const t = useTranslations("CardBuilder");
  const locale = useLocale();
  const dir = locale === 'ar' ? 'rtl' : 'ltr';

  const [primaryColor, setPrimaryColor] = useState("#4f46e5");
  const [bgColor, setBgColor] = useState("#ffffff");
  const [cardType, setCardType] = useState<CardType>('STAMP');
  
  // Type specific settings
  const [stampsCount, setStampsCount] = useState(10);
  const [cashbackPercent, setCashbackPercent] = useState(5);
  const [discountPercent, setDiscountPercent] = useState(20);
  const [subscriptionItem, setSubscriptionItem] = useState("Premium Coffee");
  const [hidePoweredBy, setHidePoweredBy] = useState(false);
  const [requireCustomerImage, setRequireCustomerImage] = useState(false);

  return (
    <div className="p-4 sm:p-8 min-h-screen bg-zinc-50 dark:bg-zinc-950 font-sans" dir={dir}>
      <div className="max-w-7xl mx-auto">
        <div className="text-center mb-10">
           <h1 className="text-4xl font-black tracking-tight text-zinc-900 dark:text-zinc-100">{t("title")}</h1>
           <p className="text-zinc-500 mt-2 text-lg font-medium">{t("subtitle")}</p>
        </div>

        <div className="flex flex-col xl:flex-row gap-8 lg:gap-12 items-start justify-center">
           
           {/* Settings Panel */}
           <div className="w-full xl:w-[500px] bg-white dark:bg-zinc-900 rounded-[2.5rem] border border-zinc-200 dark:border-zinc-800 p-8 shadow-xl">
              <h2 className="text-2xl font-bold mb-8 text-zinc-900 dark:text-zinc-100">{t("designSettings")}</h2>
              
              <div className="space-y-8">
                 {/* White-label Agency Toggle */}
                 <div className="flex items-center justify-between bg-zinc-50 dark:bg-zinc-950 p-5 rounded-2xl border border-zinc-200 dark:border-zinc-800 shadow-inner">
                    <div>
                       <div className="font-bold text-zinc-900 dark:text-white flex items-center gap-2">
                          {locale === 'ar' ? 'إخفاء شعار (Powered By WalaaPlus)' : 'Hide Powered By Watermark'}
                          <span className="bg-amber-100 text-amber-700 text-[10px] px-2 py-0.5 rounded-full uppercase tracking-widest font-black">PRO</span>
                       </div>
                       <div className="text-xs text-zinc-500 mt-1">{locale === 'ar' ? 'متاح فقط للوكالات (100% White-label)' : 'Exclusive for White-label Agencies'}</div>
                    </div>
                    <label className="relative inline-flex items-center cursor-pointer">
                      <input type="checkbox" className="sr-only peer" checked={hidePoweredBy} onChange={() => setHidePoweredBy(!hidePoweredBy)} />
                      <div className="w-14 h-7 bg-zinc-200 peer-focus:outline-none rounded-full peer dark:bg-zinc-700 peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-zinc-300 after:border after:rounded-full after:h-6 after:w-6 after:transition-all dark:border-zinc-600 peer-checked:bg-indigo-600"></div>
                    </label>
                 </div>

                 {/* Extended Profile Photo Toggle */}
                 <div className="flex items-center justify-between bg-zinc-50 dark:bg-zinc-950 p-5 rounded-2xl border border-zinc-200 dark:border-zinc-800 shadow-inner">
                    <div>
                       <div className="font-bold text-zinc-900 dark:text-white flex items-center gap-2">
                          {locale === 'ar' ? 'صورة العميل (Profile Picture)' : 'Require Customer Photo'}
                          <span className="bg-emerald-100 text-emerald-700 text-[10px] px-2 py-0.5 rounded-full uppercase tracking-widest font-black">VIP</span>
                       </div>
                       <div className="text-xs text-zinc-500 mt-1">{locale === 'ar' ? 'طلب صورة شخصية لمنع تبادل البطاقة الخاصة' : 'Print photo on card to prevent membership sharing'}</div>
                    </div>
                    <label className="relative inline-flex items-center cursor-pointer">
                      <input type="checkbox" className="sr-only peer" checked={requireCustomerImage} onChange={() => setRequireCustomerImage(!requireCustomerImage)} />
                      <div className="w-14 h-7 bg-zinc-200 peer-focus:outline-none rounded-full peer dark:bg-zinc-700 peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-zinc-300 after:border after:rounded-full after:h-6 after:w-6 after:transition-all dark:border-zinc-600 peer-checked:bg-indigo-600"></div>
                    </label>
                 </div>

                 {/* Card Type Selector */}
                 <div>
                    <label className="block text-sm font-bold text-zinc-700 dark:text-zinc-300 mb-3 uppercase tracking-wider">
                      {locale === 'ar' ? 'نوع البطاقة (Boomerangme Engine)' : 'Card Strategy Type'}
                    </label>
                    <select 
                       value={cardType} 
                       onChange={(e) => setCardType(e.target.value as CardType)}
                       className="w-full bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl px-4 py-4 outline-none focus:ring-2 focus:ring-indigo-500 font-bold text-zinc-900 dark:text-white"
                    >
                       <option value="STAMP">{locale === 'ar' ? 'بطاقة أختام (التقليدية)' : 'Stamp Card (Traditional)'}</option>
                       <option value="CASHBACK">{locale === 'ar' ? 'استرداد نقدي (Cashback)' : 'Cashback (Digital Wallet)'}</option>
                       <option value="DISCOUNT">{locale === 'ar' ? 'خصم ثابت (Discount)' : 'Flat Discount Card'}</option>
                       <option value="SUBSCRIPTION">{locale === 'ar' ? 'اشتراك مدفوع مسبقاً (Sub/Multipass)' : 'Prepaid Subscription (Multipass)'}</option>
                       <option value="GIFT">{locale === 'ar' ? 'بطاقة هدايا (Gift Card)' : 'Prepaid Gift Card'}</option>
                       <option value="COUPON">{locale === 'ar' ? 'كوبون لمرة واحدة (Coupon)' : 'Single-use Coupon'}</option>
                    </select>
                 </div>

                 {/* Dynamic Settings Based on Card Type */}
                 {cardType === 'STAMP' && (
                   <div className="bg-indigo-50 dark:bg-indigo-500/10 p-6 rounded-2xl border border-indigo-100 dark:border-indigo-500/20">
                      <label className="block text-sm font-bold text-indigo-900 dark:text-indigo-300 mb-4 uppercase tracking-wider">{t("stampsCount")}</label>
                      <input type="range" min="3" max="20" value={stampsCount} onChange={(e) => setStampsCount(Number(e.target.value))} className="w-full accent-indigo-600 h-2 bg-indigo-200 dark:bg-indigo-900 rounded-lg appearance-none cursor-pointer" />
                      <div className="text-center mt-4 font-black text-2xl text-indigo-600 dark:text-indigo-400">{stampsCount} {t("stamps")}</div>
                   </div>
                 )}

                 {cardType === 'CASHBACK' && (
                   <div className="bg-emerald-50 dark:bg-emerald-500/10 p-6 rounded-2xl border border-emerald-100 dark:border-emerald-500/20">
                      <label className="block text-sm font-bold text-emerald-900 dark:text-emerald-300 mb-4 uppercase tracking-wider">{locale === 'ar' ? 'نسبة الاسترداد النقدي' : 'Cashback Percentage return'}</label>
                      <input type="range" min="1" max="50" value={cashbackPercent} onChange={(e) => setCashbackPercent(Number(e.target.value))} className="w-full accent-emerald-600 h-2 bg-emerald-200 dark:bg-emerald-900 rounded-lg appearance-none cursor-pointer" />
                      <div className="text-center mt-4 font-black text-2xl text-emerald-600 dark:text-emerald-400">{cashbackPercent}%</div>
                   </div>
                 )}

                 {cardType === 'DISCOUNT' && (
                   <div className="bg-amber-50 dark:bg-amber-500/10 p-6 rounded-2xl border border-amber-100 dark:border-amber-500/20">
                      <label className="block text-sm font-bold text-amber-900 dark:text-amber-300 mb-4 uppercase tracking-wider">{locale === 'ar' ? 'نسبة الخصم الثابتة' : 'Flat Discount Rate'}</label>
                      <input type="range" min="5" max="100" step="5" value={discountPercent} onChange={(e) => setDiscountPercent(Number(e.target.value))} className="w-full accent-amber-600 h-2 bg-amber-200 dark:bg-amber-900 rounded-lg appearance-none cursor-pointer" />
                      <div className="text-center mt-4 font-black text-2xl text-amber-600 dark:text-amber-400">{discountPercent}% OFF</div>
                   </div>
                 )}

                 {cardType === 'SUBSCRIPTION' && (
                   <div className="bg-blue-50 dark:bg-blue-500/10 p-6 rounded-2xl border border-blue-100 dark:border-blue-500/20">
                      <label className="block text-sm font-bold text-blue-900 dark:text-blue-300 mb-4 uppercase tracking-wider">{locale === 'ar' ? 'العنصر المشترك فيه' : 'Subscription Item Name'}</label>
                      <input type="text" value={subscriptionItem} onChange={(e) => setSubscriptionItem(e.target.value)} className="w-full bg-white dark:bg-zinc-950 border border-blue-200 dark:border-blue-800 rounded-xl px-4 py-3 outline-none focus:ring-2 focus:ring-blue-500 text-blue-900 dark:text-blue-100 font-bold" />
                   </div>
                 )}

                 {/* Colors */}
                 <div className="grid grid-cols-2 gap-6 pt-4 border-t border-zinc-200 dark:border-zinc-800 mt-8">
                    <div>
                       <label className="block text-sm font-bold text-zinc-700 dark:text-zinc-300 mb-3 uppercase tracking-wider">{t("primaryColor")}</label>
                       <div className="flex items-center gap-3">
                          <input type="color" value={primaryColor} onChange={(e) => setPrimaryColor(e.target.value)} className="w-14 h-14 rounded-2xl cursor-pointer border-0 shadow-sm" />
                          <span className="text-sm font-mono font-bold text-zinc-600 dark:text-zinc-400">{primaryColor}</span>
                       </div>
                    </div>
                    <div>
                       <label className="block text-sm font-bold text-zinc-700 dark:text-zinc-300 mb-3 uppercase tracking-wider">{t("bgColor")}</label>
                       <div className="flex items-center gap-3">
                          <input type="color" value={bgColor} onChange={(e) => setBgColor(e.target.value)} className="w-14 h-14 rounded-2xl cursor-pointer border-0 shadow-sm" />
                          <span className="text-sm font-mono font-bold text-zinc-600 dark:text-zinc-400">{bgColor}</span>
                       </div>
                    </div>
                 </div>

                 <button className="w-full py-4 bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 font-black text-lg rounded-2xl transition-transform hover:scale-[1.02] active:scale-95 shadow-xl mt-6">
                    {t("saveCard")}
                 </button>
              </div>
           </div>

           {/* Live PWA / Apple Wallet Preview Panel */}
           <div className="w-full xl:w-[400px] flex justify-center sticky top-8">
             <div className="w-[350px] rounded-[3.5rem] shadow-2xl overflow-hidden flex flex-col relative ring-8 ring-white dark:ring-zinc-800 bg-white" style={{ backgroundColor: bgColor }}>
               
               {/* Setup dynamic hero geometry based on Boomerangme CardType styles */}
               {cardType === 'CASHBACK' && (
                  <div className="h-48 bg-zinc-900 relative overflow-hidden flex items-center justify-center">
                    <div className="absolute inset-0 opacity-40 mix-blend-overlay" style={{ backgroundColor: primaryColor }}></div>
                    <div className="text-white z-10 text-center">
                       <p className="text-sm font-bold uppercase tracking-widest opacity-80 mb-2">{locale === 'ar' ? 'الرصيد المتاح' : 'Available Balance'}</p>
                       <p className="text-5xl font-black tracking-tighter" dir="ltr">24,500 <span className="text-2xl opacity-80">{locale === 'ar' ? 'ل.س' : 'SYP'}</span></p>
                    </div>
                  </div>
               )}

               {cardType === 'GIFT' && (
                  <div className="h-56 relative overflow-hidden flex flex-col items-center justify-center border-b border-black/10" style={{ backgroundColor: primaryColor }}>
                    <div className="text-white z-10 text-center mt-6">
                       <p className="text-sm font-bold uppercase tracking-widest opacity-90 mb-2 text-white/80">{locale === 'ar' ? 'رصيد الهدية (Gift Balance)' : 'Gift Balance'}</p>
                       <p className="text-6xl font-black tracking-tighter" dir="ltr">50,000 <span className="text-2xl opacity-80">{locale === 'ar' ? 'ل.س' : 'SYP'}</span></p>
                    </div>
                    <div className="absolute top-4 right-4 text-xs font-bold bg-white/20 px-3 py-1 rounded-full text-white backdrop-blur-md">
                       {locale === 'ar' ? 'للإهداء' : 'Transferable'}
                    </div>
                  </div>
               )}

               {cardType === 'COUPON' && (
                  <div className="h-40 bg-zinc-900 relative overflow-hidden flex items-center justify-center">
                    <div className="absolute inset-0 opacity-40 mix-blend-overlay" style={{ backgroundColor: primaryColor }}></div>
                    <div className="text-white z-10 text-center">
                       <p className="text-3xl font-black tracking-tight mb-1">{locale === 'ar' ? 'كوبون عرض خاص!' : 'Exclusive Offer!'}</p>
                       <p className="text-sm font-bold opacity-80">{locale === 'ar' ? 'صالح لمرة واحدة فقط' : 'Valid for one-time use'}</p>
                    </div>
                  </div>
               )}

               {cardType === 'DISCOUNT' && (
                  <div className="h-48 relative flex items-center justify-center" style={{ backgroundColor: primaryColor }}>
                    <div className="text-white text-center">
                       <p className="text-sm font-bold uppercase tracking-widest opacity-90 mb-2 bg-white/20 px-4 py-1 rounded-full backdrop-blur-md inline-block">
                         {locale === 'ar' ? 'خصم متاح عبر التطبيق' : 'App Discount'}
                       </p>
                       <p className="text-7xl font-black mt-2">-{discountPercent}%</p>
                    </div>
                  </div>
               )}

               {/* Standard Apple Wallet Style Header for Stamps/Subscriptions */}
               {['STAMP', 'SUBSCRIPTION'].includes(cardType) && (
                 <div className="px-6 py-8 flex justify-between items-start text-white shadow-sm" style={{ backgroundColor: primaryColor }}>
                    <div className="w-16 h-16 bg-white/20 rounded-2xl flex items-center justify-center font-black text-3xl backdrop-blur-md shadow-inner border border-white/20 text-white">
                      W
                    </div>
                    <div className="text-end mt-1">
                       <div className="text-xs uppercase opacity-90 font-bold tracking-widest mb-1">
                          {cardType === 'STAMP' ? t("previewType") : (locale === 'ar' ? 'اشتراكك' : 'Your Subscription')}
                       </div>
                       <div className="font-black text-2xl tracking-tight">WalaaPlus</div>
                    </div>
                 </div>
               )}
               
               {/* Body Content Region */}
               <div className="flex-1 p-6 flex flex-col justify-center bg-zinc-50 border-x border-black/5 min-h-[220px]">
                  
                  {/* Dynamic User Profile Picture Request */}
                  {requireCustomerImage && (
                     <div className="flex justify-center mb-6">
                        <div className="w-20 h-20 rounded-full bg-zinc-200 dark:bg-zinc-800 border-4 border-white shadow-md overflow-hidden flex items-center justify-center relative">
                           <svg className="w-10 h-10 text-zinc-400" fill="currentColor" viewBox="0 0 24 24"><path d="M24 20.993V24H0v-2.996A14.977 14.977 0 0112.004 15c4.904 0 9.26 2.354 11.996 5.993zM16.002 8.999a4 4 0 11-8 0 4 4 0 018 0z" /></svg>
                           <div className="absolute bottom-1 bg-black/60 text-white text-[8px] px-2 py-0.5 rounded-full backdrop-blur-sm z-10 font-bold tracking-widest uppercase shadow-sm">Photo</div>
                        </div>
                     </div>
                  )}

                  <div className="bg-white backdrop-blur-2xl rounded-3xl p-6 border border-black/5 shadow-xl">
                    
                    {cardType === 'STAMP' && (
                      <div className="flex flex-wrap gap-4 justify-center">
                         {Array.from({length: stampsCount}).map((_, i) => (
                            <div key={i} className={`w-12 h-12 rounded-full border-2 flex items-center justify-center font-bold text-lg transition-all ${i < 3 ? 'shadow-md scale-105' : 'border-dashed opacity-40 bg-zinc-50'}`} style={{ borderColor: primaryColor, backgroundColor: i < 3 ? primaryColor : 'transparent', color: i < 3 ? '#fff' : primaryColor }}>
                              {i < 3 ? '✓' : i + 1}
                            </div>
                         ))}
                      </div>
                    )}

                    {cardType === 'CASHBACK' && (
                       <div className="text-center py-4">
                          <div className="text-lg font-bold text-zinc-900">{locale === 'ar' ? 'نسبة الاسترداد النقدي لكل زيارة' : 'Cashback Rate Per Visit'}</div>
                          <div className="inline-block mt-4 px-6 py-2 rounded-2xl text-4xl font-black" style={{ color: primaryColor, backgroundColor: `${primaryColor}15` }}>
                            {cashbackPercent}%
                          </div>
                       </div>
                    )}

                    {cardType === 'DISCOUNT' && (
                       <div className="text-center py-4">
                          <div className="text-lg font-bold text-zinc-900 tracking-tight">{locale === 'ar' ? 'خصم مفعّل بشكل دائم' : 'Permanent Instant Discount'}</div>
                          <div className="text-sm font-medium text-zinc-500 mt-3 px-4 leading-relaxed">
                            {locale === 'ar' ? 'أظهر هذه البطاقة للكاشير عند عملية الدفع للحصول على الخصم المباشر.' : 'Show this digital card to the cashier at checkout.'}
                          </div>
                       </div>
                    )}

                    {cardType === 'SUBSCRIPTION' && (
                       <div className="text-center py-2">
                          <div className="text-lg font-bold text-zinc-900 border-b border-zinc-100 pb-3 mb-3">{subscriptionItem}</div>
                          <div className="text-5xl font-black my-4" style={{ color: primaryColor }}>12 <span className="text-2xl text-zinc-400 font-medium">/ 30</span></div>
                          <div className="text-sm font-bold text-zinc-400 mt-2 uppercase tracking-wide">{locale === 'ar' ? 'الحصص المتبقية' : 'Remaining Claims'}</div>
                       </div>
                    )}

                  </div>
               </div>
               
               {/* Standard Footer QR */}
               <div className="p-8 bg-white flex flex-col items-center border-t border-black/5 mt-auto">
                  <div className="w-40 h-40 bg-white rounded-[2rem] shadow-xl p-3 flex items-center justify-center mb-5 border border-zinc-100 relative group cursor-pointer transition-transform hover:scale-105">
                     <img src="https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=walaaplus.com/scan/live" alt="Digital Card QR" className="w-full h-full opacity-90 mix-blend-multiply" />
                  </div>
                  <p className="text-sm font-bold text-zinc-400 tracking-wide uppercase mb-4">{t("scanHint")}</p>
                  
                  {/* The Enterprise White-label Subsystem Controller */}
                  {!hidePoweredBy && (
                     <div className="mt-4 pt-4 border-t border-zinc-100 w-full flex justify-center text-xs font-bold text-zinc-400 opacity-70 flex items-center gap-2">
                        <span className="w-5 h-5 rounded-lg bg-indigo-600 text-white flex items-center justify-center text-[10px] font-black shadow-sm tracking-tighter">W</span>
                        Powered by WalaaPlus
                     </div>
                  )}
               </div>
             </div>
           </div>

        </div>
      </div>
    </div>
  );
}
