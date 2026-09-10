import { getTranslations } from "next-intl/server";
import { Smartphone, Info, Share } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { notFound } from "next/navigation";
import { cn } from "@/lib/utils";

export default async function CustomerPWACard({ params }: { params: Promise<{ id: string, locale: string }> }) {
  const { id, locale } = await params;
  const isAr = locale === 'ar';
  
  const card = await prisma.customerCard.findUnique({
    where: { id },
    include: {
      template: true,
    }
  });

  if (!card) return notFound();

  const template = card.template;
  const primaryColor = template.primaryColor || "#4f46e5";
  const bgColor = "#ffffff";
  const stampCount = template.stampsCount || 10;
  const currentStamps = card.currentBalance;
  
  return (
    <div className="min-h-screen flex flex-col items-center p-4 sm:p-8" style={{ backgroundColor: bgColor }}>
      <div className="w-full max-w-md bg-white dark:bg-zinc-950 rounded-[2.5rem] shadow-2xl overflow-hidden flex flex-col relative ring-1 ring-black/5 dark:ring-white/10">
         {/* Apple Wallet Style Header */}
         <div className="px-6 py-8 flex justify-between items-start text-white shadow-sm" style={{ backgroundColor: primaryColor }}>
            <div className="w-16 h-16 bg-white/20 rounded-2xl flex items-center justify-center font-bold text-3xl backdrop-blur-md shadow-inner border border-white/20 text-white">
              {template.name.charAt(0)}
            </div>
            <div className="text-end">
               <div className="text-xs uppercase opacity-90 font-semibold tracking-widest mb-1">{template.type} Card</div>
               <div className="font-bold text-2xl tracking-tight">{template.name}</div>
            </div>
         </div>
         
         {/* Stamps Grid */}
         <div className="flex-1 p-8 flex flex-col justify-center bg-zinc-50 dark:bg-zinc-900 border-x border-black/5 dark:border-white/5">
            <div className="bg-white/80 dark:bg-black/20 backdrop-blur-2xl rounded-3xl p-6 border border-black/5 dark:border-white/5 shadow-xl">
               <div className="flex flex-wrap gap-4 justify-center">
                  {Array.from({length: stampCount}).map((_, i) => (
                     <div 
                       key={i} 
                       className={cn(
                         "w-14 h-14 rounded-full border-2 flex items-center justify-center text-xl font-bold transition-all shadow-sm",
                         i < currentStamps ? '' : 'border-dashed opacity-50'
                       )} 
                       style={{ 
                         borderColor: primaryColor, 
                         backgroundColor: i < currentStamps ? primaryColor : 'transparent', 
                         color: i < currentStamps ? '#fff' : primaryColor 
                       }}
                     >
                       {i < currentStamps ? '✓' : i + 1}
                     </div>
                  ))}
               </div>
            </div>
            <p className="text-center mt-6 font-bold text-zinc-600 dark:text-zinc-400">
              {isAr ? `${currentStamps} من ${stampCount} أختام تم جمعها!` : `${currentStamps} of ${stampCount} stamps collected!`}
            </p>
         </div>
         
         {/* Digital Barcode / QR */}
         <div className="p-8 bg-white dark:bg-zinc-950 flex flex-col items-center border-t border-black/5 dark:border-white/5">
            <div className="w-48 h-48 bg-white rounded-2xl shadow-lg p-2.5 flex items-center justify-center mb-6 border border-zinc-200">
               <img src={`https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${id}`} alt="QR Code" className="w-full h-full opacity-90" />
            </div>
            <div className="text-center space-y-4 w-full">
               <button className="w-full py-4 bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 font-bold rounded-2xl shadow-md hover:scale-[1.02] transition-transform active:scale-95 text-lg">
                 {isAr ? 'أضف إلى Apple Wallet' : 'Add to Apple Wallet'}
               </button>
               <button className="w-full py-4 bg-zinc-100 dark:bg-zinc-900 text-zinc-600 dark:text-zinc-400 font-bold rounded-2xl transition-colors hover:bg-zinc-200 dark:hover:bg-zinc-800">
                 {isAr ? 'أضف إلى Google Wallet' : 'Add to Google Wallet'}
               </button>
            </div>
         </div>
      </div>
      
      <div className="mt-8 text-center text-sm font-semibold text-zinc-400">
        Powered by WalaaPlus
      </div>
    </div>
  );
}
