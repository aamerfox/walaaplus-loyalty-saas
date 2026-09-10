"use client";

import { useLocale } from "next-intl";
import { Bell, Megaphone, Zap, Clock, Send, Plus, Filter, CheckCircle, AlertCircle, Loader2 } from "lucide-react";
import { useState, useEffect } from "react";
import { cn } from "@/lib/utils";

type BroadcastStatus = 'idle' | 'sending' | 'success' | 'error';

interface HistoryItem {
  id: string;
  title: string;
  message: string;
  recipientCount: number;
  createdAt: string;
}

export default function PushNotificationsPage() {
  const locale = useLocale();
  const dir = locale === 'ar' ? 'rtl' : 'ltr';
  const [activeTab, setActiveTab] = useState<'manual' | 'auto'>('manual');

  // Form state
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [status, setStatus] = useState<BroadcastStatus>('idle');
  const [statusMsg, setStatusMsg] = useState('');
  const [history, setHistory] = useState<HistoryItem[]>([]);

  const isAr = locale === 'ar';

  const loadHistory = async () => {
    try {
      const res = await fetch('/api/push/history');
      if (res.ok) {
        const data = await res.json();
        setHistory(data.notifications || []);
      }
    } catch {/* silent */}
  };

  useEffect(() => { loadHistory(); }, []);

  const handleSend = async () => {
    if (!title.trim() || !message.trim()) {
      setStatus('error');
      setStatusMsg(isAr ? 'يرجى إدخال العنوان والرسالة' : 'Please enter title and message');
      return;
    }
    setStatus('sending');
    setStatusMsg('');
    try {
      const res = await fetch('/api/push/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title.trim(), message: message.trim() }),
      });
      const data = await res.json();
      if (res.ok) {
        setStatus('success');
        setStatusMsg(
          isAr
            ? `✅ تم الإرسال! وصل إلى ${data.recipients ?? 0} مشترك`
            : `✅ Sent! Delivered to ${data.recipients ?? 0} subscribers`
        );
        setTitle('');
        setMessage('');
        loadHistory();
      } else {
        setStatus('error');
        setStatusMsg(data.error || (isAr ? 'فشل الإرسال' : 'Failed to send'));
      }
    } catch (e: any) {
      setStatus('error');
      setStatusMsg(e.message || 'Network error');
    }
  };

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950 p-6 sm:p-10 font-sans" dir={dir}>
      <div className="max-w-6xl mx-auto space-y-8">

        {/* Header */}
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-4xl font-black tracking-tight text-zinc-900 dark:text-zinc-100 flex items-center gap-3">
              <Bell className="w-10 h-10 text-indigo-600" />
              {isAr ? 'الإشعارات والأتمتة' : 'Push & Automations'}
            </h1>
            <p className="text-zinc-500 mt-2 text-lg max-w-2xl">
              {isAr
                ? 'أرسل إشعارات Push مباشرة إلى شاشات هواتف عملائك عبر OneSignal.'
                : 'Send direct push notifications to customers via OneSignal.'}
            </p>
          </div>
        </div>

        {/* Tab System */}
        <div className="flex gap-2 p-1 bg-zinc-200/50 dark:bg-zinc-800/50 rounded-2xl w-fit">
          <button
            onClick={() => setActiveTab('manual')}
            className={cn("px-6 py-2.5 rounded-xl font-bold text-sm transition-all flex items-center gap-2",
              activeTab === 'manual' ? "bg-white dark:bg-zinc-900 text-indigo-600 shadow-sm" : "text-zinc-500 hover:text-zinc-700")}
          >
            <Megaphone className="w-4 h-4" />
            {isAr ? 'إرسال يدوي' : 'Manual Broadcast'}
          </button>
          <button
            onClick={() => setActiveTab('auto')}
            className={cn("px-6 py-2.5 rounded-xl font-bold text-sm transition-all flex items-center gap-2",
              activeTab === 'auto' ? "bg-white dark:bg-zinc-900 text-indigo-600 shadow-sm" : "text-zinc-500 hover:text-zinc-700")}
          >
            <Zap className="w-4 h-4" />
            {isAr ? 'الأتمتة التلقائية' : 'Automations'}
          </button>
        </div>

        {activeTab === 'manual' ? (
          <>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
              {/* Compose Form */}
              <div className="bg-white dark:bg-zinc-900 rounded-[2rem] border border-zinc-200 dark:border-zinc-800 p-8 shadow-sm space-y-6">
                <h2 className="text-2xl font-bold text-zinc-900 dark:text-white">
                  {isAr ? 'تأليف الإشعار' : 'Compose Notification'}
                </h2>

                <div>
                  <label className="block text-sm font-bold text-zinc-700 dark:text-zinc-300 mb-2">
                    {isAr ? 'عنوان الإشعار' : 'Push Title'}
                  </label>
                  <input
                    type="text"
                    value={title}
                    onChange={e => { setTitle(e.target.value); setStatus('idle'); }}
                    placeholder={isAr ? 'مثال: عرض خاص اليوم!' : 'e.g., Special Offer Today!'}
                    maxLength={64}
                    className="w-full bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-indigo-500 font-medium"
                  />
                  <p className="text-xs text-zinc-400 mt-1 text-end">{title.length}/64</p>
                </div>

                <div>
                  <label className="block text-sm font-bold text-zinc-700 dark:text-zinc-300 mb-2">
                    {isAr ? 'نص الإشعار' : 'Push Message'}
                  </label>
                  <textarea
                    rows={4}
                    value={message}
                    onChange={e => { setMessage(e.target.value); setStatus('idle'); }}
                    placeholder={isAr ? 'اكتب الرسالة التي ستظهر على شاشة القفل...' : 'Type the message for the lock screen...'}
                    maxLength={178}
                    className="w-full bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none font-medium"
                  />
                  <p className="text-xs text-zinc-400 mt-1 text-end">{message.length}/178</p>
                </div>

                <div className="bg-indigo-50 dark:bg-indigo-500/10 border border-indigo-100 dark:border-indigo-500/20 p-4 rounded-xl flex items-start gap-3">
                  <Filter className="w-5 h-5 text-indigo-600 mt-0.5 flex-shrink-0" />
                  <div>
                    <p className="font-bold text-indigo-900 dark:text-indigo-300">{isAr ? 'الاستهداف' : 'Targeting'}</p>
                    <p className="text-sm text-indigo-700 dark:text-indigo-400 mt-1">
                      {isAr ? 'سيتم إرسال هذا الإشعار إلى جميع المشتركين عبر OneSignal.' : 'Will be sent to all OneSignal subscribers.'}
                    </p>
                  </div>
                </div>

                {/* Status Toast */}
                {status !== 'idle' && statusMsg && (
                  <div className={cn(
                    "p-4 rounded-xl flex items-start gap-3 font-medium text-sm",
                    status === 'success' ? "bg-emerald-50 text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-500/20" :
                    status === 'error' ? "bg-red-50 text-red-800 dark:bg-red-500/10 dark:text-red-300 border border-red-100 dark:border-red-500/20" :
                    "bg-blue-50 text-blue-800 border border-blue-100"
                  )}>
                    {status === 'success' ? <CheckCircle className="w-5 h-5 flex-shrink-0 mt-0.5" /> :
                     status === 'error' ? <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" /> :
                     <Loader2 className="w-5 h-5 flex-shrink-0 mt-0.5 animate-spin" />}
                    {statusMsg}
                  </div>
                )}

                <button
                  onClick={handleSend}
                  disabled={status === 'sending'}
                  className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white font-bold py-4 rounded-xl flex items-center justify-center gap-2 transition-all shadow-lg shadow-indigo-600/20"
                >
                  {status === 'sending'
                    ? <Loader2 className="w-5 h-5 animate-spin" />
                    : <Send className="w-5 h-5" />}
                  {status === 'sending'
                    ? (isAr ? 'جاري الإرسال...' : 'Sending...')
                    : (isAr ? 'إرسال الإشعار الآن' : 'Send Broadcast Now')}
                </button>
              </div>

              {/* Live iOS Preview */}
              <div className="flex justify-center items-start bg-zinc-100 dark:bg-black rounded-[2rem] p-8 border border-zinc-200 dark:border-zinc-800">
                <div className="w-[300px] h-[560px] bg-zinc-900 rounded-[3rem] border-8 border-zinc-800 relative overflow-hidden flex flex-col items-center pt-10 shadow-2xl">
                  <div className="absolute top-0 w-32 h-6 bg-zinc-800 rounded-b-3xl" />
                  <div className="text-white/80 text-6xl font-extralight mb-8 mt-4 tracking-tighter">09:41</div>
                  <div className="w-[90%] bg-zinc-800/80 backdrop-blur-xl rounded-2xl p-4 flex gap-3 mt-2">
                    <div className="w-10 h-10 bg-indigo-600 rounded-lg flex items-center justify-center flex-shrink-0">
                      <span className="text-white font-bold text-sm">W</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex justify-between items-center mb-1">
                        <span className="font-semibold text-white text-sm">WalaaPlus</span>
                        <span className="text-zinc-400 text-xs">{isAr ? 'الآن' : 'now'}</span>
                      </div>
                      <p className="text-white font-bold text-sm truncate">
                        {title || (isAr ? 'عنوان الإشعار...' : 'Notification Title...')}
                      </p>
                      <p className="text-zinc-300 text-xs line-clamp-2 mt-0.5 leading-snug">
                        {message || (isAr ? 'نص الإشعار...' : 'Notification message...')}
                      </p>
                    </div>
                  </div>
                  <div className="absolute bottom-12 w-[90%]">
                    <p className="text-center text-zinc-600 text-xs font-medium">
                      {isAr ? '← اسحب للأعلى' : 'Swipe up ↑'}
                    </p>
                  </div>
                </div>
              </div>
            </div>

            {/* Broadcast History */}
            {history.length > 0 && (
              <div className="bg-white dark:bg-zinc-900 rounded-[2rem] border border-zinc-200 dark:border-zinc-800 p-8 shadow-sm">
                <h2 className="text-xl font-bold text-zinc-900 dark:text-white mb-6">
                  {isAr ? 'سجل الإشعارات المُرسلة' : 'Broadcast History'}
                </h2>
                <div className="space-y-3">
                  {history.map(item => (
                    <div key={item.id} className="flex items-start gap-4 p-4 bg-zinc-50 dark:bg-zinc-950 rounded-2xl border border-zinc-100 dark:border-zinc-800">
                      <div className="w-10 h-10 bg-emerald-100 dark:bg-emerald-500/10 rounded-xl flex items-center justify-center flex-shrink-0">
                        <CheckCircle className="w-5 h-5 text-emerald-600" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-bold text-zinc-900 dark:text-white text-sm">{item.title}</p>
                        <p className="text-zinc-500 text-sm truncate">{item.message}</p>
                      </div>
                      <div className="text-end flex-shrink-0">
                        <p className="text-xs font-bold text-emerald-600">{item.recipientCount} {isAr ? 'مشترك' : 'recipients'}</p>
                        <p className="text-xs text-zinc-400">{new Date(item.createdAt).toLocaleDateString(locale)}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 p-6 rounded-[2rem]">
                <div className="flex justify-between items-start mb-4">
                  <div className="w-12 h-12 bg-rose-50 dark:bg-rose-500/10 text-rose-600 rounded-xl flex items-center justify-center">
                    <Zap className="w-6 h-6" />
                  </div>
                  <div className="w-14 h-8 bg-zinc-100 dark:bg-zinc-800 rounded-full flex items-center p-1 cursor-pointer">
                    <div className="w-6 h-6 bg-white dark:bg-zinc-600 rounded-full shadow-sm" />
                  </div>
                </div>
                <h3 className="text-xl font-bold text-zinc-900 dark:text-zinc-100 mb-2">{isAr ? 'إشعار عيد الميلاد' : 'Birthday Trigger'}</h3>
                <p className="text-zinc-500 text-sm mb-4">{isAr ? 'إشعار مجاني في يوم ميلاد العميل.' : 'Auto-send a free stamp on birthday.'}</p>
                <div className="flex items-center gap-2 text-xs font-bold text-zinc-400 bg-zinc-50 dark:bg-zinc-950 w-fit px-3 py-1.5 rounded-lg border border-zinc-100 dark:border-zinc-800">
                  <Clock className="w-3.5 h-3.5" />
                  {isAr ? 'يومياً الساعة 10 صباحاً' : 'Daily at 10 AM'}
                </div>
              </div>
              <div className="bg-white dark:bg-zinc-900 border border-indigo-200 dark:border-indigo-800 p-6 rounded-[2rem] shadow-md shadow-indigo-500/5">
                <div className="flex justify-between items-start mb-4">
                  <div className="w-12 h-12 bg-indigo-50 dark:bg-indigo-500/10 text-indigo-600 rounded-xl flex items-center justify-center">
                    <Zap className="w-6 h-6" />
                  </div>
                  <div className="w-14 h-8 bg-indigo-600 rounded-full flex items-center p-1 cursor-pointer justify-end">
                    <div className="w-6 h-6 bg-white rounded-full shadow-sm" />
                  </div>
                </div>
                <h3 className="text-xl font-bold text-zinc-900 dark:text-zinc-100 mb-2">{isAr ? 'استعادة العملاء النائمين' : 'Win-back Sleeping'}</h3>
                <p className="text-zinc-500 text-sm mb-4">{isAr ? 'إشعار للعملاء الغائبين 30 يوماً.' : 'Auto-ping customers absent for 30 days.'}</p>
                <div className="flex items-center gap-2 text-xs font-bold text-zinc-400 bg-zinc-50 dark:bg-zinc-950 w-fit px-3 py-1.5 rounded-lg border border-zinc-100 dark:border-zinc-800">
                  <Clock className="w-3.5 h-3.5" />
                  {isAr ? 'تلقائياً (نشط)' : 'Auto (Active)'}
                </div>
              </div>
            </div>
            <button className="w-full bg-zinc-50 hover:bg-zinc-100 dark:bg-zinc-900 border-2 border-dashed border-zinc-200 dark:border-zinc-800 rounded-[2rem] p-6 flex flex-col items-center justify-center text-zinc-500 hover:text-indigo-600 transition-colors">
              <Plus className="w-8 h-8 mb-2" />
              <span className="font-bold">{isAr ? 'إنشاء قاعدة أتمتة جديدة' : 'Create Custom Rule'}</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
