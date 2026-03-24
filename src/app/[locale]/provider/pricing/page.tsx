import { Check } from "lucide-react";

export default function AgencyPricingPage() {
  const tiers = [
    {
      name: "وكالة مبتدئة (Starter Agency)",
      price: "500,000",
      description: "حل مثالي لبدء وكالة ولاء في السوق السوري مع ما يصل إلى 10 أنشطة تجارية.",
      features: [
        "إدارة حتى 10 أنشطة تجارية",
        "تطبيق ماسح للكاشير",
        "بطاقات أختام ذكية فقط",
        "تحليلات أساسية"
      ],
      popular: false
    },
    {
      name: "وكالة متقدمة (Pro Agency)",
      price: "1,500,000",
      description: "النطاق الأفضل لشركات التسويق لإدارة ولاء عدد كبير من الأنشطة عبر الدومين الخاص.",
      features: [
        "إدارة حتى 50 نشاط تجاري",
        "جميع أنواع البطاقات (Cashback, Discount)",
        "رابط ماسح خاص (White-label)",
        "إشعارات Push جغرافية",
        "دومين خاص (Custom Domain)"
      ],
      popular: true
    },
    {
      name: "وكالة ذهبية (Ultimate PWA)",
      price: "3,000,000",
      description: "بنية تحتية غير محدودة تقدم نظام ولاء كامل كمزود خدمة حصري لمئات المقاهي.",
      features: [
        "أنشطة تجارية غير محدودة",
        "تراخيص لبيع المنصة باسمك (100% White-label)",
        "دعم فني خاص 24/7",
        "واجهة برمجة تطبيقات API مخصصة",
        "نظام مكافآت متعدد المستويات"
      ],
      popular: false
    }
  ];

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950 p-6 sm:p-12 font-sans" dir="rtl">
      <div className="max-w-7xl mx-auto space-y-12">
        <div className="text-center max-w-2xl mx-auto">
           <h1 className="text-4xl sm:text-5xl font-black tracking-tight text-zinc-900 dark:text-zinc-100 mb-4">
             باقات الاشتراك للوكالات
           </h1>
           <p className="text-zinc-500 text-lg">
             ابدأ بتقديم منصة <strong>WalaaPlus</strong> كخدمتك الخاصة للشركات والمقاهي في سوريا بأسعار تنافسية.
           </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-8 items-start">
           {tiers.map((tier) => (
              <div 
                key={tier.name} 
                className={`bg-white dark:bg-zinc-900 rounded-[2.5rem] p-8 transition-transform hover:scale-[1.02] shadow-xl relative
                  ${tier.popular ? 'border-2 border-indigo-600 dark:border-indigo-500 shadow-indigo-600/10' : 'border border-zinc-200 dark:border-zinc-800'}
                `}
              >
                {tier.popular && (
                  <div className="absolute top-0 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-indigo-600 text-white px-4 py-1.5 rounded-full text-xs font-bold tracking-widest shadow-md">
                    الأكثر طلباً للمسوقين
                  </div>
                )}
                <h3 className="text-2xl font-black text-zinc-900 dark:text-zinc-100">{tier.name}</h3>
                <p className="text-zinc-500 mt-3 text-sm leading-relaxed">{tier.description}</p>
                
                <div className="my-8 flex items-end gap-2 text-indigo-600 dark:text-indigo-400">
                   <span className="text-5xl font-black tracking-tighter" dir="ltr">{tier.price}</span>
                   <span className="text-lg font-bold mb-2">ل.س / <span className="text-sm font-medium opacity-80">شهرياً</span></span>
                </div>
                
                <ul className="space-y-4 mb-8">
                   {tier.features.map(f => (
                     <li key={f} className="flex items-start gap-3 text-zinc-700 dark:text-zinc-300 font-medium">
                        <Check className="w-5 h-5 text-emerald-500 flex-shrink-0 mt-0.5" />
                        <span>{f}</span>
                     </li>
                   ))}
                </ul>
                
                <button className={`w-full py-4 font-bold text-lg rounded-2xl transition-all shadow-lg active:scale-95
                  ${tier.popular 
                    ? 'bg-indigo-600 hover:bg-indigo-700 text-white' 
                    : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-white hover:bg-zinc-200 dark:hover:bg-zinc-700'
                  }
                `}>
                  بدء الاستضافة
                </button>
              </div>
           ))}
        </div>
        
        {/* Billing Activity Audit log for SaaS Provider */}
        <div className="bg-white dark:bg-zinc-900 rounded-[2.5rem] border border-zinc-200 dark:border-zinc-800 overflow-hidden shadow-xl mt-12 w-full">
           <div className="p-8 border-b border-zinc-200 dark:border-zinc-800 flex justify-between items-center bg-zinc-50/50 dark:bg-zinc-900/50">
              <div>
                <h2 className="text-xl font-bold text-zinc-900 dark:text-zinc-100">سجل الإيرادات وإدارة الوكالات</h2>
                <p className="text-sm text-zinc-500 mt-1">يقتصر العرض على مدير النظام (Super Admin)</p>
              </div>
              <div className="text-end">
                 <div className="text-xs font-bold text-zinc-400 uppercase tracking-widest mb-1">صافي الإيرادات المتكررة (MRR)</div>
                 <div className="text-3xl font-black text-emerald-600" dir="ltr">12,500,000 <span className="text-sm">ل.س</span></div>
              </div>
           </div>
           
           <div className="overflow-x-auto">
              <table className="w-full text-start text-sm" dir="rtl">
                 <thead className="bg-zinc-50 dark:bg-zinc-950/50 text-zinc-500 font-medium border-b border-zinc-200 dark:border-zinc-800">
                   <tr>
                      <th className="px-8 py-5">الوكالة (العميل)</th>
                      <th className="px-8 py-5">الباقة المشترك بها</th>
                      <th className="px-8 py-5">قيمة الفاتورة المجدولة</th>
                      <th className="px-8 py-5">حالة الدفع</th>
                   </tr>
                 </thead>
                 <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
                   <tr className="hover:bg-zinc-50 dark:hover:bg-zinc-800/20 transition-colors">
                      <td className="px-8 py-6 font-bold text-zinc-900 dark:text-zinc-100">تسويق دمشق (Damascus Marketing)</td>
                      <td className="px-8 py-6 text-zinc-600 dark:text-zinc-400">وكالة متقدمة (Pro Agency)</td>
                      <td className="px-8 py-6 text-zinc-900 dark:text-white font-bold" dir="ltr">1,500,000 <span className="text-xs font-normal">SYP</span></td>
                      <td className="px-8 py-6">
                         <span className="text-emerald-600 dark:text-emerald-400 bg-emerald-100 dark:bg-emerald-500/10 px-3 py-1.5 rounded-full font-bold text-xs tracking-wide">
                            مدفوع (نشط)
                         </span>
                      </td>
                   </tr>
                   <tr className="hover:bg-zinc-50 dark:hover:bg-zinc-800/20 transition-colors">
                      <td className="px-8 py-6 font-bold text-zinc-900 dark:text-zinc-100">وكالة إبتكار سوريا</td>
                      <td className="px-8 py-6 text-zinc-600 dark:text-zinc-400">وكالة ذهبية (Ultimate PWA)</td>
                      <td className="px-8 py-6 text-zinc-900 dark:text-white font-bold" dir="ltr">3,000,000 <span className="text-xs font-normal">SYP</span></td>
                      <td className="px-8 py-6">
                         <span className="text-amber-600 dark:text-amber-400 bg-amber-100 dark:bg-amber-500/10 px-3 py-1.5 rounded-full font-bold text-xs tracking-wide">
                            بانتظار التحويل البنكي
                         </span>
                      </td>
                   </tr>
                 </tbody>
              </table>
           </div>
        </div>
      </div>
    </div>
  );
}
