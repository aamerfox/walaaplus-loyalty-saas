"use client";

import { useLocale } from "next-intl";
import { Star, MessageSquareQuote, Map, Link as LinkIcon, Save, Activity, Loader2, CheckCircle, AlertCircle } from "lucide-react";
import { useState, useEffect } from "react";
import { cn } from "@/lib/utils";

export default function FeedbackCollectionPage() {
  const locale = useLocale();
  const dir = locale === 'ar' ? 'rtl' : 'ltr';
  const isAr = locale === 'ar';
  const [activeTab, setActiveTab] = useState<'settings' | 'results'>('settings');

  // Settings state
  const [enabled, setEnabled] = useState(true);
  const [googleMapsUrl, setGoogleMapsUrl] = useState('');
  const [negativeMessage, setNegativeMessage] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'success' | 'error'>('idle');

  // Stats state
  const [stats, setStats] = useState({ avg: "0.0", googleCount: 0, internalCount: 0, total: 0 });
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    // Load settings
    fetch('/api/feedback/settings')
      .then(r => r.json())
      .then(data => {
        const s = data.settings || {};
        setEnabled(s.enabled !== false);
        setGoogleMapsUrl(s.googleMapsUrl || '');
        setNegativeMessage(s.negativeMessage || (isAr ? 'نعتذر إن كانت تجربتك غير مثالية. نرجو منك إخبارنا كيف يمكننا التحسين:' : 'We are sorry your experience was not perfect. Please let us know how we can improve:'));
      });

    // Load stats
    fetch('/api/feedback')
      .then(r => r.json())
      .then(data => {
        if (data.stats) setStats(data.stats);
        setIsLoading(false);
      });
  }, [isAr]);

  const handleSave = async () => {
    setIsSaving(true);
    setSaveStatus('idle');
    try {
      const res = await fetch('/api/feedback/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled, googleMapsUrl, negativeMessage }),
      });
      if (res.ok) setSaveStatus('success');
      else setSaveStatus('error');
    } catch {
      setSaveStatus('error');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950 p-6 sm:p-10 font-sans" dir={dir}>
      <div className="max-w-5xl mx-auto space-y-8">
        
        {/* Header */}
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
           <div>
              <h1 className="text-4xl font-black tracking-tight text-zinc-900 dark:text-zinc-100 flex items-center gap-3">
                <Star className="w-10 h-10 text-amber-500 fill-amber-500" />
                {isAr ? 'تقييم العملاء (Feedback)' : 'Feedback Collection'}
              </h1>
              <p className="text-zinc-500 mt-2 text-lg max-w-2xl">
                {isAr 
                  ? 'اجمع تقييمات العملاء تلقائياً بعد كل زيارة. وجه التقييمات الإيجابية (5 نجوم) لخرائط جوجل لزيادة تصنيفك.' 
                  : 'Auto-collect feedback after visits. Route 5-star reviews directly to Google Maps to boost your rating!'}
              </p>
           </div>
        </div>

        {/* Tab System */}
        <div className="flex gap-2 p-1 bg-zinc-200/50 dark:bg-zinc-800/50 rounded-2xl w-fit">
           <button 
             onClick={() => setActiveTab('settings')}
             className={cn(
               "px-6 py-2.5 rounded-xl font-bold text-sm transition-all flex items-center gap-2",
               activeTab === 'settings' ? "bg-white dark:bg-zinc-900 text-amber-600 shadow-sm" : "text-zinc-500 hover:text-zinc-700"
             )}
           >
             <MessageSquareQuote className="w-4 h-4" />
             {isAr ? 'إعدادات التقييم' : 'Settings'}
           </button>
           <button 
             onClick={() => setActiveTab('results')}
             className={cn(
               "px-6 py-2.5 rounded-xl font-bold text-sm transition-all flex items-center gap-2",
               activeTab === 'results' ? "bg-white dark:bg-zinc-900 text-amber-600 shadow-sm" : "text-zinc-500 hover:text-zinc-700"
             )}
           >
             <Activity className="w-4 h-4" />
             {isAr ? 'النتائج والتحليلات' : 'Results'}
           </button>
        </div>

        {activeTab === 'settings' ? (
           <div className="bg-white dark:bg-zinc-900 rounded-[2rem] border border-zinc-200 dark:border-zinc-800 p-8 shadow-sm space-y-8">
              
              <div className="flex items-center justify-between p-4 bg-zinc-50 dark:bg-zinc-950 rounded-2xl border border-zinc-200 dark:border-zinc-800">
                 <div>
                    <h3 className="font-bold text-lg text-zinc-900 dark:text-zinc-100">
                      {isAr ? 'تفعيل جمع التقييمات التلقائي' : 'Enable Automatic Feedback Collection'}
                    </h3>
                    <p className="text-zinc-500 text-sm mt-1">
                      {isAr ? 'إرسال إشعار للعميل لتقييم تجربته بعد ساعة من حصوله على ختم جديد.' : 'Send a push notification 1 hour after a visit asking for a review.'}
                    </p>
                 </div>
                 <div 
                   onClick={() => setEnabled(!enabled)}
                   className={cn(
                     "w-14 h-8 rounded-full flex items-center p-1 cursor-pointer transition-all",
                     enabled ? "bg-amber-500 justify-end" : "bg-zinc-300 dark:bg-zinc-700 justify-start"
                   )}
                 >
                    <div className="w-6 h-6 bg-white rounded-full shadow-sm"></div>
                 </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                 <div className="space-y-4">
                    <div className="flex items-center gap-2 text-zinc-900 dark:text-zinc-100">
                       <Map className="w-5 h-5 text-indigo-600" />
                       <h4 className="font-bold">{isAr ? 'رابط خرائط جوجل (Google Maps)' : 'Google Maps URL'}</h4>
                    </div>
                    <p className="text-sm text-zinc-500">
                      {isAr ? 'سيتم توجيه العملاء الذين يمنحونك 5 نجوم تلقائياً إلى هذا الرابط.' : 'Customers who rate 5 stars will be redirected here.'}
                    </p>
                    <div className="relative">
                       <div className="absolute inset-y-0 start-0 pl-3 flex items-center pointer-events-none px-4">
                          <LinkIcon className="h-5 w-5 text-zinc-400" />
                       </div>
                       <input 
                         type="url" 
                         value={googleMapsUrl}
                         onChange={e => setGoogleMapsUrl(e.target.value)}
                         placeholder="https://g.page/r/..."
                         className="w-full bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl py-3 px-12 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500"
                       />
                    </div>
                 </div>

                 <div className="space-y-4">
                    <div className="flex items-center gap-2 text-zinc-900 dark:text-zinc-100">
                       <MessageSquareQuote className="w-5 h-5 text-rose-500" />
                       <h4 className="font-bold">{isAr ? 'رسالة التقييمات السلبية (1-4 نجوم)' : 'Negative Feedback Message'}</h4>
                    </div>
                    <p className="text-sm text-zinc-500">
                      {isAr ? 'ماذا سيقرأ العميل إذا قيّم بـ 4 نجوم أو أقل؟' : 'What will the customer see if they rate 4 stars or below?'}
                    </p>
                    <textarea 
                      rows={3}
                      value={negativeMessage}
                      onChange={e => setNegativeMessage(e.target.value)}
                      className="w-full bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl p-4 text-sm focus:outline-none focus:ring-2 focus:ring-rose-500 resize-none"
                    />
                 </div>
              </div>

              <div className="pt-6 border-t border-zinc-200 dark:border-zinc-800 flex items-center justify-between">
                 <div>
                    {saveStatus === 'success' && (
                       <p className="text-emerald-600 text-sm font-bold flex items-center gap-1">
                         <CheckCircle className="w-4 h-4" /> {isAr ? 'تم الحفظ بنجاح!' : 'Settings saved successfully!'}
                       </p>
                    )}
                    {saveStatus === 'error' && (
                       <p className="text-rose-600 text-sm font-bold flex items-center gap-1">
                         <AlertCircle className="w-4 h-4" /> {isAr ? 'فشل الحفظ' : 'Failed to save settings'}
                       </p>
                    )}
                 </div>
                 <button 
                   onClick={handleSave}
                   disabled={isSaving}
                   className="bg-amber-500 hover:bg-amber-600 text-white font-bold px-8 py-3 rounded-xl flex items-center gap-2 transition-all disabled:opacity-50"
                 >
                    {isSaving ? <Loader2 className="w-5 h-5 animate-spin" /> : <Save className="w-5 h-5" />}
                    {isAr ? 'حفظ الإعدادات' : 'Save Settings'}
                 </button>
              </div>
           </div>
        ) : (
           <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <div className="bg-white dark:bg-zinc-900 rounded-[2rem] border border-zinc-200 dark:border-zinc-800 p-8 flex flex-col items-center justify-center text-center">
                 <div className="text-6xl font-black text-amber-500 flex items-center gap-2 mb-2">
                   {stats.avg}
                   <Star className="w-10 h-10 fill-amber-500" />
                 </div>
                 <p className="text-zinc-500 font-medium">
                   {isAr ? 'متوسط تقييم العملاء الداخلي' : 'Average Internal Score'}
                 </p>
              </div>
              <div className="bg-white dark:bg-zinc-900 rounded-[2rem] border border-zinc-200 dark:border-zinc-800 p-8 flex flex-col items-center justify-center text-center">
                 <div className="text-5xl font-black text-indigo-600 mb-2">{stats.googleCount}</div>
                 <p className="text-zinc-500 font-medium">
                   {isAr ? 'تقييم إيجابي وجهته لخرائط جوجل' : '5-Star Redirects to Google'}
                 </p>
              </div>
              <div className="bg-white dark:bg-zinc-900 rounded-[2rem] border border-zinc-200 dark:border-zinc-800 p-8 flex flex-col items-center justify-center text-center">
                 <div className="text-5xl font-black text-rose-500 mb-2">{stats.internalCount}</div>
                 <p className="text-zinc-500 font-medium">
                   {isAr ? 'تقييم سلبي تم احتواؤه' : 'Negative Reviews Contained'}
                 </p>
              </div>
           </div>
        )}

      </div>
    </div>
  );
}
