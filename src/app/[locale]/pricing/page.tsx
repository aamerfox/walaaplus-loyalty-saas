"use client";

import { useLocale } from "next-intl";
import { Link } from "@/i18n/routing";
import { Check, ArrowRight, Building2, Store } from "lucide-react";

export default function PricingPage() {
  const locale = useLocale();
  const dir = locale === 'ar' ? 'rtl' : 'ltr';

  const plans = [
    {
      nameAr: "الباقة الأساسية (للمتاجر)",
      nameEn: "Basic (For Local Shops)",
      icon: Store,
      price: "150,000",
      currencyAr: "ل.س / شهرياً",
      currencyEn: "SYP / mo",
      descAr: "مثالي للمقاهي الصغيرة والصالونات التي تبدأ برنامج ولاء.",
      descEn: "Perfect for small cafes and salons starting a loyalty program.",
      featuresAr: [
        "1 موقع (Geofencing)",
        "تصميم بطاقة واحدة",
        "1000 عميل نشط",
        "أتمتة الرسائل القصيرة (SMS)",
        "دعم عبر البريد الإلكتروني"
      ],
      featuresEn: [
        "1 Geofencing Location",
        "1 Active Card Design",
        "1,000 Active Customers",
        "SMS Automations",
        "Email Support"
      ],
      ctaAr: "ابدأ التجربة المجانية",
      ctaEn: "Start Free Trial",
      popular: false
    },
    {
      nameAr: "باقة النمو (للشركات)",
      nameEn: "Growth (For Businesses)",
      icon: Building2,
      price: "450,000",
      currencyAr: "ل.س / شهرياً",
      currencyEn: "SYP / mo",
      descAr: "للشركات المتنامية التي تحتاج ميزات متقدمة وتحليلات عميقة.",
      descEn: "For growing businesses needing advanced features and deep analytics.",
      featuresAr: [
        "10 مواقع (Geofencing)",
        "قوالب بطاقات غير محدودة",
        "عملاء بطاقات غير محدود",
        "نظام جمع التقييمات (Feedback)",
        "تحليلات RFM المتقدمة",
        "إزالة شعار WalaaPlus"
      ],
      featuresEn: [
        "10 Geofencing Locations",
        "Unlimited Card Templates",
        "Unlimited Customers",
        "Feedback Collection System",
        "Advanced RFM Analytics",
        "Remove 'Powered By' Watermark"
      ],
      ctaAr: "اشترك الآن",
      ctaEn: "Subscribe Now",
      popular: true
    },
    {
      nameAr: "وكالة العلامة البيضاء (SaaS)",
      nameEn: "White-label Agency",
      icon: Building2,
      price: "مخصص",
      currencyAr: "",
      currencyEn: "Custom",
      descAr: "لوكالات التسويق التي ترغب ببيع النظام تحت علامتها التجارية.",
      descEn: "For marketing agencies looking to resell the platform under their own brand.",
      featuresAr: [
        "لوحة تحكم وكالة متكاملة",
        "إدارة حسابات فرعية للتجار",
        "نطاق ويب مخصص (CNAME)",
        "ربط بوابات دفع سورية مجانية",
        "تطبيق ماسح ضوئي مخصص (Cashier)",
        "دعم برمجي مخصص طوال أيام الأسبوع"
      ],
      featuresEn: [
        "Master Agency Dashboard",
        "Manage Sub-accounts (Merchants)",
        "Custom Domain Mapping (CNAME)",
        "Syrian Payment Gateway Integrations",
        "Custom Branded Cashier App",
        "24/7 Dedicated Engineering Support"
      ],
      ctaAr: "تواصل مع المبيعات",
      ctaEn: "Contact Sales",
      popular: false
    }
  ];

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950 font-sans text-zinc-900 dark:text-zinc-50 pt-32 pb-24" dir={dir}>
      
      {/* Navigation Re-used directly for fast demo */}
      <nav className="fixed top-0 inset-x-0 z-50 bg-white/80 dark:bg-zinc-950/80 backdrop-blur-xl border-b border-zinc-200 dark:border-zinc-800">
        <div className="max-w-7xl mx-auto px-6 h-20 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-3">
             <div className="w-10 h-10 rounded-xl bg-indigo-600 flex items-center justify-center shadow-lg shadow-indigo-600/20">
                <span className="text-white font-black text-xl">W</span>
             </div>
             <span className="font-black text-2xl tracking-tighter">WalaaPlus</span>
          </Link>
          <div className="flex items-center gap-4">
             <Link href="/auth/login" className="hidden sm:block font-bold text-sm tracking-wide text-zinc-600 dark:text-zinc-300 hover:text-indigo-600">
                {locale === 'ar' ? 'دخول' : 'Log In'}
             </Link>
             <Link href={locale === 'ar' ? '/en/pricing' : '/ar/pricing'} className="w-10 h-10 rounded-full border border-zinc-200 dark:border-zinc-800 flex items-center justify-center font-bold text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors">
                {locale === 'ar' ? 'EN' : 'ع'}
             </Link>
          </div>
        </div>
      </nav>

      <div className="max-w-7xl mx-auto px-6">
        
        {/* Header */}
        <div className="text-center max-w-3xl mx-auto mb-20">
          <h1 className="text-4xl sm:text-6xl font-black tracking-tight mb-6">
            {locale === 'ar' ? 'أسعار شفافة لنمو عملك' : 'Transparent Pricing for Growth'}
          </h1>
          <p className="text-xl text-zinc-500 font-medium leading-relaxed">
            {locale === 'ar' 
              ? 'سواء كنت مقهى صغيراً أو وكالة تسويق كبرى، لدينا خطة تناسب ميزانيتك. ابدأ مجاناً وادفع فقط عندما تنمو.' 
              : 'Whether you are a local cafe or a global marketing agency, we have a plan for you. Start free, pay as you grow.'}
          </p>
        </div>

        {/* Pricing Cards */}
        <div className="grid lg:grid-cols-3 gap-8 items-start">
           {plans.map((plan, i) => (
             <div key={i} className={`relative bg-white dark:bg-zinc-900 rounded-[2.5rem] p-8 border ${plan.popular ? 'border-indigo-500 shadow-2xl scale-105 z-10' : 'border-zinc-200 dark:border-zinc-800 shadow-lg'}`}>
                
                {plan.popular && (
                  <div className="absolute top-0 inset-x-0 -translate-y-1/2 flex justify-center">
                    <span className="bg-indigo-600 text-white text-xs font-black uppercase tracking-widest py-1.5 px-4 rounded-full shadow-lg border-4 border-white dark:border-zinc-900">
                      {locale === 'ar' ? 'الأكثر شعبية' : 'Most Popular'}
                    </span>
                  </div>
                )}

                <div className="flex items-center gap-4 mb-6">
                  <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${plan.popular ? 'bg-indigo-100 dark:bg-indigo-900/50 text-indigo-600 dark:text-indigo-400' : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400'}`}>
                    <plan.icon size={24} />
                  </div>
                  <h3 className="text-xl font-bold">{locale === 'ar' ? plan.nameAr : plan.nameEn}</h3>
                </div>

                <div className="mb-6 flex items-baseline gap-2">
                  <span className="text-4xl sm:text-5xl font-black">{plan.price}</span>
                  <span className="text-zinc-500 font-bold">{locale === 'ar' ? plan.currencyAr : plan.currencyEn}</span>
                </div>

                <p className="text-zinc-500 font-medium mb-8 h-12">
                  {locale === 'ar' ? plan.descAr : plan.descEn}
                </p>

                <Link
                  href="/auth/register"
                  className={`w-full py-4 rounded-xl font-black text-lg flex items-center justify-center gap-2 transition-transform active:scale-95 mb-8 ${plan.popular ? 'bg-indigo-600 hover:bg-indigo-700 text-white shadow-xl shadow-indigo-600/30' : 'bg-zinc-100 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 text-zinc-900 dark:text-white'}`}
                >
                  {locale === 'ar' ? plan.ctaAr : plan.ctaEn}
                  <ArrowRight size={20} className={locale === 'ar' ? 'rotate-180' : ''} />
                </Link>

                <div className="space-y-4">
                  {(locale === 'ar' ? plan.featuresAr : plan.featuresEn).map((feature, j) => (
                    <div key={j} className="flex items-center gap-3">
                      <div className="w-6 h-6 rounded-full bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600 flex items-center justify-center flex-shrink-0">
                        <Check size={14} strokeWidth={3} />
                      </div>
                      <span className="font-medium text-zinc-700 dark:text-zinc-300">{feature}</span>
                    </div>
                  ))}
                </div>

             </div>
           ))}
        </div>

      </div>
    </div>
  );
}
