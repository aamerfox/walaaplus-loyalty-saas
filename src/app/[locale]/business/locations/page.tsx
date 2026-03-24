"use client";

import { useTranslations } from "next-intl";
import { useLocale } from "next-intl";
import { MapPin, Plus, Navigation, Crosshair, AlertCircle, Trash2 } from "lucide-react";
import { useState } from "react";

export default function GeofencingPage() {
  const locale = useLocale();
  const dir = locale === 'ar' ? 'rtl' : 'ltr';

  const [locations, setLocations] = useState([
    { id: 1, name: locale === 'ar' ? 'فرع دمشق - المزة' : 'Damascus Branch', lat: '33.5138', lng: '36.2765', active: true },
    { id: 2, name: locale === 'ar' ? 'مركز التسوق - سيتي مول' : 'City Mall Kiosk', lat: '33.5200', lng: '36.2900', active: true }
  ]);

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950 p-6 sm:p-10 font-sans" dir={dir}>
      <div className="max-w-7xl mx-auto space-y-8">
        
        {/* Header */}
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
           <div>
              <h1 className="text-4xl font-black tracking-tight text-zinc-900 dark:text-zinc-100 flex items-center gap-3">
                <Navigation className="w-10 h-10 text-indigo-600" />
                {locale === 'ar' ? 'السياج الجغرافي (Geofencing)' : 'Geofence Locations'}
              </h1>
              <p className="text-zinc-500 mt-2 text-lg max-w-2xl">
                {locale === 'ar' 
                  ? 'أضف مواقع فروعك الجغرافية. عندما يقترب العميل مسافة 100 متر من الموقع، ستظهر بطاقة الولاء فوراً على شاشة القفل (شاشة الهاتف) لتذكيره بالدخول.' 
                  : 'Add up to 10 GPS coordinates. When a customer walks within 100m of this location, their Wallet card will automatically pop up on their lock screen.'}
              </p>
           </div>
           
           <button className="bg-indigo-600 hover:bg-indigo-700 text-white px-6 py-3 rounded-2xl font-bold flex items-center gap-2 transition-all shadow-lg active:scale-95 whitespace-nowrap">
              <Plus className="w-5 h-5" />
              {locale === 'ar' ? 'إضافة فرع جديد' : 'Add Location'}
           </button>
        </div>

        {/* Warning Banner */}
        <div className="bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-800/30 rounded-2xl p-4 flex items-start gap-4">
           <AlertCircle className="w-6 h-6 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
           <div>
              <h4 className="font-bold text-amber-800 dark:text-amber-300">
                {locale === 'ar' ? 'قيد Apple Wallet' : 'Apple Wallet Limitation'}
              </h4>
              <p className="text-amber-700/80 dark:text-amber-400/80 text-sm mt-1">
                {locale === 'ar' 
                  ? 'يسمح نظام أبل بتخزين 10 مواقع جغرافية فقط لكل بطاقة كحد أقصى. يرجى إدخال أهم فروعك فقط.' 
                  : 'Apple natively restricts you to a maximum of 10 encoded GPS locations per pass.'}
              </p>
           </div>
           <div className="ms-auto font-black text-amber-800 dark:text-amber-400 text-xl">
             {locations.length}/10
           </div>
        </div>

        {/* Locations List */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
           {locations.map((loc) => (
             <div key={loc.id} className="bg-white dark:bg-zinc-900 rounded-[2rem] border border-zinc-200 dark:border-zinc-800 p-6 shadow-xl relative overflow-hidden group">
                <div className="absolute top-0 right-0 p-4 opacity-0 group-hover:opacity-100 transition-opacity">
                   <button className="text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-500/10 p-2 rounded-xl transition-colors">
                     <Trash2 className="w-5 h-5" />
                   </button>
                </div>

                <div className="w-14 h-14 bg-indigo-50 dark:bg-indigo-500/10 text-indigo-600 rounded-2xl flex items-center justify-center mb-6">
                   <MapPin className="w-7 h-7" />
                </div>
                
                <h3 className="text-xl font-bold text-zinc-900 dark:text-zinc-100 mb-4">{loc.name}</h3>
                
                <div className="space-y-3 bg-zinc-50 dark:bg-zinc-950 p-4 rounded-xl border border-zinc-100 dark:border-zinc-800">
                   <div className="flex justify-between items-center text-sm">
                      <span className="text-zinc-500 font-bold tracking-wider">{locale === 'ar' ? 'خط العرض (Lat)' : 'Latitude'}</span>
                      <span className="font-mono text-zinc-900 dark:text-zinc-300 bg-white dark:bg-zinc-900 px-2 py-1 rounded-md border border-zinc-200 dark:border-zinc-800">{loc.lat}</span>
                   </div>
                   <div className="flex justify-between items-center text-sm">
                      <span className="text-zinc-500 font-bold tracking-wider">{locale === 'ar' ? 'خط الطول (Lng)' : 'Longitude'}</span>
                      <span className="font-mono text-zinc-900 dark:text-zinc-300 bg-white dark:bg-zinc-900 px-2 py-1 rounded-md border border-zinc-200 dark:border-zinc-800">{loc.lng}</span>
                   </div>
                   <div className="flex justify-between items-center pt-2 mt-2 border-t border-zinc-200 dark:border-zinc-800">
                      <span className="text-xs text-zinc-400 font-bold">{locale === 'ar' ? 'رسالة الشاشة:' : 'Lockscreen Text:'}</span>
                      <span className="text-xs text-indigo-600 dark:text-indigo-400 font-bold">
                        {locale === 'ar' ? 'مرحباً بك بالقرب منا!' : 'Welcome nearby!'}
                      </span>
                   </div>
                </div>

                <div className="mt-6 flex gap-3">
                   <button className="flex-1 py-3 bg-zinc-100 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 text-zinc-900 dark:text-white font-bold rounded-xl transition-colors flex items-center justify-center gap-2 text-sm">
                      <Crosshair className="w-4 h-4" />
                      {locale === 'ar' ? 'تعديل النطاق' : 'Edit Coordinates'}
                   </button>
                </div>
             </div>
           ))}

           {/* Empty Add Slot if under 10 */}
           {locations.length < 10 && (
             <button className="bg-zinc-50/50 hover:bg-zinc-100 dark:bg-zinc-900/50 dark:hover:bg-zinc-800 border-2 border-dashed border-zinc-200 dark:border-zinc-800 rounded-[2rem] p-6 flex flex-col items-center justify-center text-zinc-400 hover:text-indigo-600 transition-colors min-h-[280px]">
                <Plus className="w-12 h-12 mb-4" />
                <span className="font-bold text-lg">{locale === 'ar' ? 'إضافة إحداثيات جديدة' : 'Add New Coordinates'}</span>
                <span className="text-sm mt-1">{10 - locations.length} {locale === 'ar' ? 'متبقي' : 'slots remaining'}</span>
             </button>
           )}
        </div>

      </div>
    </div>
  );
}
