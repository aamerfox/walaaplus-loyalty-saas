"use client";

import { Search, Loader2, CheckCircle, XCircle } from "lucide-react";
import { useLocale } from "next-intl";
import { useEffect, useState } from "react";
import { Html5QrcodeScanner } from "html5-qrcode";
import { cn } from "@/lib/utils";

export default function CashierScanner() {
  const locale = useLocale();
  const dir = locale === 'ar' ? 'rtl' : 'ltr';
  const isAr = locale === 'ar';
  
  const [scanResult, setScanResult] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successData, setSuccessData] = useState<{ newBalance: number, customerName: string } | null>(null);
  const [phone, setPhone] = useState('');

  useEffect(() => {
    const scanner = new Html5QrcodeScanner(
      "reader",
      { fps: 10, qrbox: { width: 250, height: 250 }, aspectRatio: 1.0 },
      false
    );

    scanner.render(
      (decodedText) => {
        handleAwardStamp(decodedText);
        scanner.clear();
      },
      () => {}
    );

    return () => {
      scanner.clear().catch(() => {});
    };
  }, []);

  const handleAwardStamp = async (cardId: string) => {
    setIsProcessing(true);
    setError(null);
    setScanResult(cardId);
    try {
      const res = await fetch('/api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cardId, action: 'award_stamp' }),
      });
      const data = await res.json();
      if (res.ok) {
        setSuccessData(data);
      } else {
        setError(data.error || 'Scan failed');
      }
    } catch {
      setError('Network error');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleManualAward = async () => {
    if (!phone) return;
    setIsProcessing(true);
    setError(null);
    try {
      // In a real app, first find card by phone, then award
      const res = await fetch('/api/scan/manual', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, action: 'award_stamp' }),
      });
      const data = await res.json();
      if (res.ok) setSuccessData(data);
      else setError(data.error || 'Lookup failed');
    } catch {
      setError('Network error');
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-white flex flex-col font-sans" dir={dir}>
       <div className="p-6 border-b border-zinc-800 flex justify-between items-center shadow-sm">
         <span className="font-bold text-xl tracking-wide">WalaaPlus Scanner</span>
         <div className="w-10 h-10 bg-zinc-900 rounded-full flex items-center justify-center font-bold text-zinc-400 border border-zinc-800">C1</div>
       </div>

       <div className="flex-1 flex flex-col items-center justify-start p-6 space-y-8 overflow-y-auto w-full max-w-lg mx-auto">
          
          {successData ? (
            <div className="w-full bg-emerald-900/30 border border-emerald-500/50 rounded-3xl p-8 text-center space-y-4 shadow-xl">
               <div className="w-16 h-16 bg-emerald-500 rounded-full flex items-center justify-center mx-auto mb-4 shadow-lg shadow-emerald-500/20">
                 <CheckCircle className="w-8 h-8 text-white" />
               </div>
               <h3 className="text-xl font-bold text-emerald-400">{isAr ? 'تم بنجاح!' : 'Awarded Successfully!'}</h3>
               <div className="p-6 bg-black/20 rounded-2xl border border-white/5 space-y-2">
                 <p className="text-sm text-zinc-400">{isAr ? 'رصيد العميلة الجديد:' : 'New Stamp Balance:'}</p>
                 <div className="text-5xl font-black text-white">{successData.newBalance}</div>
               </div>
               <button onClick={() => window.location.reload()} className="mt-4 px-6 py-4 w-full bg-emerald-600 hover:bg-emerald-700 text-white rounded-2xl font-bold transition-all shadow-md">
                 {isAr ? 'مسح بطاقة أخرى' : 'Scan Next Card'}
               </button>
            </div>
          ) : error ? (
            <div className="w-full bg-rose-900/30 border border-rose-500/50 rounded-3xl p-8 text-center space-y-4 shadow-xl">
               <XCircle className="w-16 h-16 text-rose-500 mx-auto" />
               <h3 className="text-xl font-bold text-rose-400">{isAr ? 'خطأ في العملية' : 'Error Occurred'}</h3>
               <p className="text-rose-200">{error}</p>
               <button onClick={() => {setError(null); setScanResult(null); window.location.reload();}} className="mt-4 px-6 py-4 w-full bg-rose-600 hover:bg-rose-700 text-white rounded-2xl font-bold">
                 {isAr ? 'حاول مجدداً' : 'Try Again'}
               </button>
            </div>
          ) : (
            <>
               <div className={cn("w-full bg-black border border-zinc-700/50 rounded-[2rem] flex flex-col items-center justify-center relative overflow-hidden shadow-2xl p-4", isProcessing && "opacity-50 grayscale")}>
                  <div id="reader" className="w-full rounded-2xl overflow-hidden" />
                  {isProcessing && <div className="absolute inset-0 flex items-center justify-center bg-black/20"><Loader2 className="w-12 h-12 animate-spin text-white" /></div>}
                  <p className="mt-6 mb-2 text-zinc-400 font-medium text-sm text-center">
                    {isAr ? 'وجه الكاميرا نحو بطاقة العميل' : 'Point camera at customer digital card'}
                  </p>
               </div>

               <div className="text-center text-zinc-600 font-bold uppercase tracking-widest text-sm py-2">{isAr ? 'أو' : 'OR'}</div>

               <div className="w-full space-y-4">
                  <div className="relative">
                     <Search className="w-5 h-5 absolute start-4 top-4 text-zinc-500" />
                     <input 
                       type="text" 
                       value={phone}
                       onChange={e => setPhone(e.target.value)}
                       placeholder={isAr ? 'أدخل رقم الهاتف (+963)' : 'Enter Phone (+963)'}
                       className="w-full bg-zinc-900 border border-zinc-800 rounded-2xl ps-12 pe-4 py-4 text-white focus:ring-2 focus:ring-indigo-500 outline-none transition-all placeholder-zinc-600 shadow-inner" 
                       dir="ltr"
                     />
                  </div>
                  <button 
                    onClick={handleManualAward}
                    disabled={isProcessing || !phone}
                    className="w-full py-4 bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-lg rounded-2xl transition-all shadow-lg active:scale-95 disabled:opacity-50"
                  >
                    {isProcessing ? <Loader2 className="mx-auto animate-spin" /> : (isAr ? 'إضافة ختم يدوياً' : 'Award Stamp Manually')}
                  </button>
               </div>
            </>
          )}
       </div>
    </div>
  );
}
