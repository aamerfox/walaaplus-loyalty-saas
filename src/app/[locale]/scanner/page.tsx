"use client";

import { Search } from "lucide-react";
import { useLocale } from "next-intl";
import { useEffect, useState } from "react";
import { Html5QrcodeScanner } from "html5-qrcode";

export default function CashierScanner() {
  const locale = useLocale();
  const dir = locale === 'ar' ? 'rtl' : 'ltr';
  const [scanResult, setScanResult] = useState<string | null>(null);

  useEffect(() => {
    // Initialize Web-based Camera Scanner once component mounts
    const scanner = new Html5QrcodeScanner(
      "reader",
      { fps: 10, qrbox: { width: 250, height: 250 }, aspectRatio: 1.0 },
      false
    );

    scanner.render(
      (decodedText) => {
        setScanResult(decodedText);
        // Automatically stop scanning after successful scan
        scanner.clear();
      },
      (error) => {
        // Ignore rapid scan errors (expected while seeking)
      }
    );

    return () => {
      scanner.clear().catch(console.error);
    };
  }, []);

  return (
    <div className="min-h-screen bg-zinc-950 text-white flex flex-col font-sans" dir={dir}>
       <div className="p-6 border-b border-zinc-800 flex justify-between items-center shadow-sm">
         <span className="font-bold text-xl tracking-wide">WalaaPlus Scanner</span>
         <div className="w-10 h-10 bg-zinc-900 rounded-full flex items-center justify-center font-bold text-zinc-400 border border-zinc-800">
           C1
         </div>
       </div>

       <div className="flex-1 flex flex-col items-center justify-start p-6 space-y-8 overflow-y-auto w-full max-w-lg mx-auto">
          
          {scanResult ? (
            <div className="w-full bg-emerald-900/30 border border-emerald-500/50 rounded-3xl p-8 text-center space-y-4 shadow-xl">
               <div className="w-16 h-16 bg-emerald-500 rounded-full flex items-center justify-center mx-auto mb-4 shadow-lg shadow-emerald-500/20">
                 <svg className="w-8 h-8 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>
               </div>
               <h3 className="text-xl font-bold text-emerald-400">Scan Successful!</h3>
               <p className="text-emerald-200 font-medium break-all bg-black/20 p-4 rounded-xl">{scanResult}</p>
               <button onClick={() => window.location.reload()} className="mt-4 px-6 py-4 w-full bg-emerald-600 hover:bg-emerald-700 text-white rounded-2xl font-bold transition-all shadow-md">
                 Scan Next Card
               </button>
            </div>
          ) : (
            <div className="w-full bg-black border border-zinc-700/50 rounded-[2rem] flex flex-col items-center justify-center relative overflow-hidden shadow-2xl p-4">
               {/* Real Camera Feed Mount Point */}
               <div id="reader" className="w-full rounded-2xl overflow-hidden [&>video]:rounded-xl [&>video]:object-cover" />
               <p className="mt-6 mb-2 text-zinc-400 font-medium text-sm tracking-wide text-center">
                 {locale === 'ar' ? 'وجه كاميرا هاتفك نحو بطاقة العميل' : 'Point your phone camera at customer digital card'}
               </p>
            </div>
          )}

          <div className="text-center text-zinc-600 font-bold uppercase tracking-widest text-sm py-2">
             {locale === 'ar' ? 'أو' : 'OR'}
          </div>

          <div className="w-full">
             <div className="relative">
                <Search className="w-5 h-5 absolute start-4 top-4 text-zinc-500" />
                <input 
                  type="text" 
                  placeholder={locale === 'ar' ? 'أدخل رقم الهاتف السوري (+963)' : 'Enter Syrian Phone (+963)'}
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-2xl ps-12 pe-4 py-4 text-white focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none transition-all placeholder-zinc-600 focus:bg-zinc-950 shadow-inner" 
                  dir="ltr"
                />
             </div>
             <button className="w-full mt-4 py-4 bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-lg rounded-2xl transition-all shadow-lg active:scale-95">
               {locale === 'ar' ? 'إضافة ختم يدوياً' : 'Award Stamp Manually'}
             </button>
          </div>
       </div>
    </div>
  );
}
