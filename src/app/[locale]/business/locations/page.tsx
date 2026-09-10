"use client";

import { MapPin, Plus, Navigation, Crosshair, AlertCircle, Trash2, Loader2, X } from "lucide-react";
import { useState, useEffect } from "react";
import { useLocale } from "next-intl";
import { cn } from "@/lib/utils";

export default function GeofencingPage() {
  const locale = useLocale();
  const dir = locale === 'ar' ? 'rtl' : 'ltr';
  const isAr = locale === 'ar';

  const [locations, setLocations] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [formData, setFormData] = useState({
    name: "",
    address: "",
    lat: "",
    lng: "",
    radius: "100",
    message: ""
  });

  useEffect(() => {
    fetchLocations();
  }, []);

  const fetchLocations = async () => {
    setIsLoading(true);
    try {
      const res = await fetch('/api/locations');
      const data = await res.json();
      setLocations(data.locations || []);
    } catch (err) {
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    try {
      const res = await fetch('/api/locations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData)
      });
      if (res.ok) {
        setIsModalOpen(false);
        setFormData({ name: "", address: "", lat: "", lng: "", radius: "100", message: "" });
        fetchLocations();
      }
    } catch (err) {
      console.error(err);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm(isAr ? 'هل أنت متأكد من حذف هذا الموقع؟' : 'Are you sure you want to delete this location?')) return;
    try {
      await fetch(`/api/locations/${id}`, { method: 'DELETE' });
      fetchLocations();
    } catch (err) {
      console.error(err);
    }
  };

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950 p-6 sm:p-10 font-sans" dir={dir}>
      <div className="max-w-7xl mx-auto space-y-8 text-start">
        
        {/* Header */}
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
           <div>
              <h1 className="text-4xl font-black tracking-tight text-zinc-900 dark:text-zinc-100 flex items-center gap-3">
                <Navigation className="w-10 h-10 text-indigo-600" />
                {isAr ? 'السياج الجغرافي (Geofencing)' : 'Geofence Locations'}
              </h1>
              <p className="text-zinc-500 mt-2 text-lg max-w-2xl">
                {isAr 
                  ? 'أضف مواقع فروعك الجغرافية. عندما يقترب العميل من الموقع، ستظهر بطاقة الولاء فوراً على شاشة القفل لتذكيره بالدخول.' 
                  : 'Add your business GPS coordinates. When a customer walks nearby, their Wallet card will automatically pop up on their lock screen.'}
              </p>
           </div>
           
           <button 
             onClick={() => setIsModalOpen(true)}
             className="bg-indigo-600 hover:bg-indigo-700 text-white px-6 py-3 rounded-2xl font-bold flex items-center gap-2 transition-all shadow-lg active:scale-95 whitespace-nowrap"
           >
              <Plus className="w-5 h-5" />
              {isAr ? 'إضافة فرع جديد' : 'Add Location'}
           </button>
        </div>

        {/* Warning Banner */}
        <div className="bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-800/30 rounded-2xl p-4 flex items-start gap-4">
           <AlertCircle className="w-6 h-6 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
           <div>
              <h4 className="font-bold text-amber-800 dark:text-amber-300">
                {isAr ? 'قيد Apple Wallet' : 'Apple Wallet Limitation'}
              </h4>
              <p className="text-amber-700/80 dark:text-amber-400/80 text-sm mt-1">
                {isAr 
                  ? 'يسمح نظام أبل بتخزين 10 مواقع جغرافية فقط لكل بطاقة كحد أقصى. يرجى إدخال أهم فروعك فقط.' 
                  : 'Apple natively restricts you to a maximum of 10 encoded GPS locations per pass.'}
              </p>
           </div>
           <div className="ms-auto font-black text-amber-800 dark:text-amber-400 text-xl">
             {locations.length}/10
           </div>
        </div>

        {/* Locations List */}
        {isLoading ? (
          <div className="flex justify-center p-20"><Loader2 className="w-10 h-10 animate-spin text-zinc-300" /></div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {locations.map((loc) => (
              <div key={loc.id} className="bg-white dark:bg-zinc-900 rounded-[2rem] border border-zinc-200 dark:border-zinc-800 p-6 shadow-xl relative overflow-hidden group">
                  <div className="absolute top-0 right-0 p-4 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button 
                      onClick={() => handleDelete(loc.id)}
                      className="text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-500/10 p-2 rounded-xl transition-colors"
                    >
                      <Trash2 className="w-5 h-5" />
                    </button>
                  </div>

                  <div className="w-14 h-14 bg-indigo-50 dark:bg-indigo-500/10 text-indigo-600 rounded-2xl flex items-center justify-center mb-6">
                    <MapPin className="w-7 h-7" />
                  </div>
                  
                  <h3 className="text-xl font-bold text-zinc-900 dark:text-zinc-100 mb-4">{loc.name}</h3>
                  
                  <div className="space-y-3 bg-zinc-50 dark:bg-zinc-950 p-4 rounded-xl border border-zinc-100 dark:border-zinc-800">
                    <div className="flex justify-between items-center text-sm">
                        <span className="text-zinc-500 font-bold tracking-wider">{isAr ? 'خط العرض' : 'Latitude'}</span>
                        <span className="font-mono text-zinc-900 dark:text-zinc-300 bg-white dark:bg-zinc-900 px-2 py-1 rounded-md border border-zinc-200 dark:border-zinc-800">{loc.lat}</span>
                    </div>
                    <div className="flex justify-between items-center text-sm">
                        <span className="text-zinc-500 font-bold tracking-wider">{isAr ? 'خط الطول' : 'Longitude'}</span>
                        <span className="font-mono text-zinc-900 dark:text-zinc-300 bg-white dark:bg-zinc-900 px-2 py-1 rounded-md border border-zinc-200 dark:border-zinc-800">{loc.lng}</span>
                    </div>
                    <div className="flex justify-between items-center text-sm pt-2 border-t border-zinc-100 dark:border-zinc-800">
                        <span className="text-zinc-500 font-bold tracking-wider">{isAr ? 'نطاق التنبيه' : 'Alert Radius'}</span>
                        <span className="font-bold text-indigo-600 dark:text-indigo-400">{loc.radius}m</span>
                    </div>
                    {loc.lockscreenMessage && (
                      <div className="flex flex-col gap-1 pt-2">
                          <span className="text-[10px] text-zinc-400 font-black uppercase tracking-widest">{isAr ? 'رسالة التنبيه:' : 'Alert Message:'}</span>
                          <span className="text-xs text-zinc-700 dark:text-zinc-300 italic">"{loc.lockscreenMessage}"</span>
                      </div>
                    )}
                  </div>
              </div>
            ))}

            {/* Empty Add Slot if under 10 */}
            {locations.length < 10 && (
              <button 
                onClick={() => setIsModalOpen(true)}
                className="bg-zinc-50/50 hover:bg-zinc-100 dark:bg-zinc-900/50 dark:hover:bg-zinc-800 border-2 border-dashed border-zinc-200 dark:border-zinc-800 rounded-[2rem] p-6 flex flex-col items-center justify-center text-zinc-400 hover:text-indigo-600 transition-colors min-h-[280px]"
              >
                  <Plus className="w-12 h-12 mb-4" />
                  <span className="font-bold text-lg">{isAr ? 'إضافة إحداثيات جديدة' : 'Add New Coordinates'}</span>
                  <span className="text-sm mt-1">{10 - locations.length} {isAr ? 'متبقي' : 'slots remaining'}</span>
              </button>
            )}
          </div>
        )}
      </div>

      {/* Add Location Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm shadow-black">
          <div className="bg-white dark:bg-zinc-900 w-full max-w-xl rounded-[2.5rem] shadow-2xl border border-zinc-200 dark:border-zinc-800 overflow-hidden text-start">
            <div className="p-8 border-b border-zinc-100 dark:border-zinc-800 flex justify-between items-center">
              <h2 className="text-2xl font-black">{isAr ? 'إضافة فرع جديد' : 'New Location'}</h2>
              <button onClick={() => setIsModalOpen(false)} className="p-2 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-full transition-colors">
                <X className="w-6 h-6" />
              </button>
            </div>
            
            <form onSubmit={handleSubmit} className="p-8 space-y-6 max-h-[70vh] overflow-y-auto">
              <div className="space-y-4">
                <div className="space-y-1.5">
                  <label className="text-sm font-bold text-zinc-500 uppercase tracking-widest">{isAr ? 'اسم الفرع' : 'Location Name'}</label>
                  <input 
                    required
                    value={formData.name}
                    onChange={(e) => setFormData({...formData, name: e.target.value})}
                    type="text" 
                    placeholder={isAr ? 'مثلاً: فرع المزة' : 'e.g. Damascus Branch'}
                    className="w-full bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-2xl px-5 py-4 focus:ring-2 focus:ring-indigo-500 outline-none" 
                  />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <label className="text-sm font-bold text-zinc-500 uppercase tracking-widest">{isAr ? 'خط العرض (Lat)' : 'Latitude'}</label>
                    <input 
                      required
                      value={formData.lat}
                      onChange={(e) => setFormData({...formData, lat: e.target.value})}
                      type="text" 
                      placeholder="33.5138"
                      className="w-full bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-2xl px-5 py-4 focus:ring-2 focus:ring-indigo-500 outline-none font-mono" 
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-sm font-bold text-zinc-500 uppercase tracking-widest">{isAr ? 'خط الطول (Lng)' : 'Longitude'}</label>
                    <input 
                      required
                      value={formData.lng}
                      onChange={(e) => setFormData({...formData, lng: e.target.value})}
                      type="text" 
                      placeholder="36.2765"
                      className="w-full bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-2xl px-5 py-4 focus:ring-2 focus:ring-indigo-500 outline-none font-mono" 
                    />
                  </div>
                </div>

                <div className="space-y-1.5">
                    <div className="flex justify-between items-center">
                      <label className="text-sm font-bold text-zinc-500 uppercase tracking-widest">{isAr ? 'نطاق التنبيه (Radius)' : 'Alert Radius'}</label>
                      <span className="text-indigo-600 font-black">{formData.radius}m</span>
                    </div>
                    <input 
                      type="range" 
                      min="50" 
                      max="500" 
                      step="50"
                      value={formData.radius}
                      onChange={(e) => setFormData({...formData, radius: e.target.value})}
                      className="w-full h-2 bg-zinc-200 dark:bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-indigo-600" 
                    />
                    <p className="text-[10px] text-zinc-400 font-medium italic mt-1">
                      {isAr ? '* تظهر البطاقة على شاشة القفل عندما يكون العميل ضمن هذا النطاق.' : '* The card pops up on lockscreen within this distance.'}
                    </p>
                </div>

                <div className="space-y-1.5">
                  <label className="text-sm font-bold text-zinc-500 uppercase tracking-widest">{isAr ? 'رسالة التنبيه' : 'Alert Message'}</label>
                  <input 
                    value={formData.message}
                    onChange={(e) => setFormData({...formData, message: e.target.value})}
                    type="text" 
                    placeholder={isAr ? 'مرحباً! تفضل بزيارتنا اليوم' : 'e.g. Welcome! visit us for a surprise'}
                    className="w-full bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-2xl px-5 py-4 focus:ring-2 focus:ring-indigo-500 outline-none" 
                  />
                </div>
              </div>

              <div className="pt-6 flex gap-3">
                <button 
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="flex-1 py-4 bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 font-bold rounded-2xl"
                >
                  {isAr ? 'إلغاء' : 'Cancel'}
                </button>
                <button 
                  type="submit"
                  disabled={isSubmitting}
                  className="flex-2 py-4 px-10 bg-indigo-600 hover:bg-indigo-700 text-white font-bold rounded-2xl shadow-lg transition-all flex items-center justify-center gap-2"
                >
                  {isSubmitting ? <Loader2 className="animate-spin" /> : (isAr ? 'حفظ الموقع' : 'Save Geofence')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

    </div>
  );
}
