"use client";

import { useLocale } from "next-intl";
import { useState, useEffect } from "react";
import { Copy, Key, Webhook, Fingerprint, Activity, Server, ArrowRight, Loader2, CheckCircle, RefreshCw, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";

interface WebhookConfig {
  url: string;
  active: boolean;
}

interface WebhookSettings {
  cardIssued: WebhookConfig;
  cardScanned: WebhookConfig;
  feedbackReceived: WebhookConfig;
}

export default function DeveloperHubPage() {
  const locale = useLocale();
  const dir = locale === 'ar' ? 'rtl' : 'ltr';
  const isAr = locale === 'ar';

  const [apiToken, setApiToken] = useState("");
  const [webhooks, setWebhooks] = useState<WebhookSettings>({
    cardIssued: { url: "", active: false },
    cardScanned: { url: "", active: false },
    feedbackReceived: { url: "", active: false },
  });

  const [isLoading, setIsLoading] = useState(true);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [toast, setToast] = useState<{ type: 'success' | 'error', msg: string } | null>(null);

  useEffect(() => {
    fetch('/api/developer/settings')
      .then(r => r.json())
      .then(data => {
        if (data.apiToken) setApiToken(data.apiToken);
        if (data.webhookSettings) setWebhooks(data.webhookSettings);
        setIsLoading(false);
      })
      .catch(() => setIsLoading(false));
  }, []);

  const handleGenerateKey = async () => {
    setIsGenerating(true);
    try {
      const res = await fetch('/api/developer/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'generate_key' }),
      });
      const data = await res.json();
      if (data.apiToken) setApiToken(data.apiToken);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleSaveWebhooks = async () => {
    setIsSaving(true);
    setToast(null);
    try {
      const res = await fetch('/api/developer/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ webhookSettings: webhooks }),
      });
      if (res.ok) setToast({ type: 'success', msg: isAr ? 'تم حفظ الإعدادات بنجاح!' : 'Webhooks saved successfully!' });
      else setToast({ type: 'error', msg: isAr ? 'فشل الحفظ' : 'Failed to save' });
    } catch {
      setToast({ type: 'error', msg: 'Network error' });
    } finally {
      setIsSaving(false);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    alert(isAr ? 'تم النسخ!' : 'Copied!');
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950 flex items-center justify-center">
        <Loader2 className="w-10 h-10 animate-spin text-zinc-400" />
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-8 min-h-screen bg-zinc-50 dark:bg-zinc-950 font-sans" dir={dir}>
      <div className="max-w-6xl mx-auto">
        <div className="mb-10">
           <div className="flex items-center gap-3 mb-4">
              <div className="w-12 h-12 rounded-2xl bg-zinc-200 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 flex items-center justify-center"><Server size={24} /></div>
              <h1 className="text-4xl font-black tracking-tight text-zinc-900 dark:text-zinc-100">{isAr ? 'المطورين والربط (API & Webhooks)' : 'Developer Hub'}</h1>
           </div>
           <p className="text-zinc-500 mt-2 text-lg font-medium">
             {isAr ? 'اربط نظام ولاء بلس مع أكثر من 5000 تطبيق عبر Zapier أو Make.' : 'Connect WalaaPlus with over 5,000 apps via Zapier or Make.'}
           </p>
        </div>

        <div className="space-y-10">
           <div className="bg-white dark:bg-zinc-900 rounded-[2.5rem] border border-zinc-200 dark:border-zinc-800 overflow-hidden shadow-xl">
              <div className="p-8 pb-0">
                 <div className="flex items-center gap-3 mb-2">
                    <Key size={24} className="text-indigo-600 dark:text-indigo-400" />
                    <h2 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">{isAr ? 'مفتاح الربط البرمجي' : 'Static API Key'}</h2>
                 </div>
                 <p className="text-zinc-500 font-medium text-sm mb-6">{isAr ? 'لا تشارك هذا المفتاح أبداً، استخدمه كمفتاح Bearer Token.' : 'Never share this token publicly. Use it as a Bearer Token.'}</p>
              </div>
              <div className="p-8 pt-4">
                 {apiToken ? (
                   <div className="relative group">
                      <div className="absolute inset-y-0 start-0 flex items-center ps-5 pointer-events-none"><Fingerprint className="text-zinc-400" size={20} /></div>
                      <input type="text" readOnly value={apiToken} className="block w-full p-4 ps-14 text-sm text-zinc-900 font-mono font-bold bg-zinc-50 rounded-2xl border border-zinc-200 dark:bg-zinc-950 dark:border-zinc-800 dark:text-white" />
                      <div className="absolute inset-y-2 end-2 flex gap-2">
                        <button onClick={() => copyToClipboard(apiToken)} className="bg-zinc-100 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 text-zinc-900 dark:text-white font-bold rounded-xl px-4 py-2 text-sm flex items-center gap-2 transition-colors"><Copy size={16} /> {isAr ? 'نسخ' : 'Copy'}</button>
                        <button onClick={handleGenerateKey} disabled={isGenerating} className="bg-indigo-600 hover:bg-indigo-700 text-white font-bold rounded-xl px-4 py-2 text-sm transition-colors">{isGenerating ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}</button>
                      </div>
                   </div>
                 ) : (
                   <button onClick={handleGenerateKey} disabled={isGenerating} className="w-full py-6 border-2 border-dashed border-zinc-300 dark:border-zinc-700 rounded-3xl text-indigo-600 font-bold flex items-center justify-center gap-2 hover:bg-indigo-50 transition-all">
                      {isGenerating ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                      {isAr ? 'إنشاء مفتاح API جديد' : 'Generate New API Key'}
                   </button>
                 )}
              </div>
           </div>

           <div className="bg-white dark:bg-zinc-900 rounded-[2.5rem] border border-zinc-200 dark:border-zinc-800 p-8 shadow-xl">
              <div className="flex items-center gap-3 mb-2">
                 <Webhook size={24} className="text-emerald-600 dark:text-emerald-400" />
                 <h2 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">{isAr ? 'الويب هوك الصادر' : 'Outgoing Webhooks'}</h2>
              </div>
              <p className="text-zinc-500 font-medium text-sm mb-8">{isAr ? 'أدخل روابط الاستماع الخاصة بك.' : 'Enter your Catch Hook URLs for real-time events.'}</p>

              <div className="space-y-6">
                 {(['cardIssued', 'cardScanned', 'feedbackReceived'] as const).map(evt => (
                   <div key={evt} className="bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-2xl p-6 transition-all focus-within:border-emerald-500/50">
                      <div className="flex items-center justify-between mb-4">
                         <div className="flex items-center gap-2">
                            <span className={cn("w-2 h-2 rounded-full", webhooks[evt].active ? "bg-emerald-500 animate-pulse" : "bg-zinc-300 dark:bg-zinc-700")}></span>
                            <span className="font-bold text-zinc-900 dark:text-zinc-100 uppercase tracking-widest text-xs">event.{evt.replace(/[A-Z]/g, letter => `.${letter.toLowerCase()}`)}</span>
                         </div>
                         <div onClick={() => setWebhooks({...webhooks, [evt]: {...webhooks[evt], active: !webhooks[evt].active}})} className={cn("w-10 h-5 rounded-full flex items-center p-0.5 cursor-pointer transition-all", webhooks[evt].active ? "bg-emerald-500 justify-end" : "bg-zinc-300 dark:bg-zinc-700 justify-start")}>
                            <div className="w-4 h-4 bg-white rounded-full shadow-sm" />
                         </div>
                      </div>
                      <input 
                        type="url" 
                        value={webhooks[evt].url} 
                        onChange={e => setWebhooks({...webhooks, [evt]: {...webhooks[evt], url: e.target.value}})}
                        placeholder="https://hook.yourdomain.com/..." 
                        className="w-full bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl px-4 py-3 text-sm font-mono text-zinc-600 outline-none focus:ring-2 focus:ring-emerald-500" 
                      />
                   </div>
                 ))}
              </div>
              
              <div className="mt-8 flex items-center justify-between">
                 <div>
                    {toast?.type === 'success' && <p className="text-emerald-600 font-bold text-sm flex items-center gap-1"><CheckCircle size={16}/> {toast.msg}</p>}
                    {toast?.type === 'error' && <p className="text-rose-600 font-bold text-sm flex items-center gap-1"><AlertCircle size={16}/> {toast.msg}</p>}
                 </div>
                 <button onClick={handleSaveWebhooks} disabled={isSaving} className="bg-emerald-600 hover:bg-emerald-700 text-white px-8 py-3 rounded-xl font-black text-lg shadow-lg shadow-emerald-600/20 active:scale-95 transition-transform flex items-center gap-2 disabled:opacity-50">
                    {isSaving ? <Loader2 size={20} className="animate-spin" /> : <Activity size={20} />}
                    {isAr ? 'حفظ واختبار الروابط' : 'Save & Ping Webhooks'}
                 </button>
              </div>
           </div>
        </div>
      </div>
    </div>
  );
}
