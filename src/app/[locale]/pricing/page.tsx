"use client";

import { Wordmark } from "@/components/brand/Wordmark";
import { useLocale, useTranslations } from "next-intl";
import { Link } from "@/i18n/routing";
import { Check, Building2, Store } from "lucide-react";
import { buttonClass, Card } from "@/components/ui";

export default function PricingPage() {
  const locale = useLocale();
  const t = useTranslations("Landing");

  const plans = [
    {
      nameAr: "الباقة الأساسية (للمتاجر)",
      nameEn: "Basic (For Local Shops)",
      icon: Store,
      priceAr: "150,000",
      priceEn: "150,000",
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
      priceAr: "450,000",
      priceEn: "450,000",
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
        "إزالة شعار Zademi"
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
      priceAr: "مخصص",
      priceEn: "Custom",
      currencyAr: "",
      currencyEn: "",
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
    <div className="min-h-screen bg-app">
      {/* The landing page's navigation, not a copy of it: one public chrome, one set of controls. */}
      <nav className="sticky top-0 z-50 border-b border-border bg-surface/90 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-4 px-4 sm:h-20 sm:px-6">
          <Link href="/" aria-label="Zademi" className="inline-flex">
            <Wordmark height={28} className="h-7 w-auto" />
          </Link>
          <div className="ms-auto flex items-center gap-2">
            {/* Below `sm` the bar holds the mark, one action and the language. Three controls and a
                logo do not fit a 390px phone without the primary action wrapping onto two lines. */}
            <div className="hidden sm:block">
              <Link href="/auth/login" className={buttonClass("ghost", "sm")}>
                {t("navLogin")}
              </Link>
            </div>
            <Link href="/auth/register" className={buttonClass("primary", "sm")}>
              {t("ctaStart")}
            </Link>
            <Link
              href="/pricing"
              locale={locale === "ar" ? "en" : "ar"}
              aria-label={locale === "ar" ? t("switchToEnglish") : t("switchToArabic")}
              className="flex size-9 items-center justify-center rounded-xl border border-border text-sm font-bold text-ink-muted transition-colors hover:bg-surface-muted hover:text-ink"
            >
              <span aria-hidden="true">{locale === "ar" ? "EN" : "ع"}</span>
            </Link>
          </div>
        </div>
      </nav>

      <header className="bg-navy-900 py-16 text-center text-white sm:py-20">
        <div className="mx-auto max-w-3xl px-4 sm:px-6">
          <h1 className="font-display text-3xl font-extrabold tracking-tight sm:text-5xl">{t("pricingTitle")}</h1>
          <p className="mx-auto mt-4 max-w-2xl text-lg leading-relaxed text-white/75">{t("pricingSubtitle")}</p>
        </div>
      </header>

      <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-20">

        {/* Pricing Cards */}
        <div className="grid items-start gap-5 lg:grid-cols-3">
           {plans.map((plan, i) => (
             <Card key={i} className={`relative ${plan.popular ? "ring-2 ring-turquoise-500" : ""}`}>

                {plan.popular && (
                  <div className="absolute top-0 inset-x-0 -translate-y-1/2 flex justify-center">
                    <span className="rounded-full bg-turquoise-500 px-4 py-1.5 text-xs font-bold uppercase tracking-widest text-navy-950">
                      {locale === 'ar' ? 'الأكثر شعبية' : 'Most Popular'}
                    </span>
                  </div>
                )}

                <div className="flex items-center gap-4 mb-6">
                  <div className={`flex size-12 items-center justify-center rounded-2xl ${plan.popular ? "bg-turquoise-50 text-turquoise-700 dark:bg-navy-800 dark:text-turquoise-200" : "bg-surface-muted text-ink-muted"}`}>
                    <plan.icon size={24} />
                  </div>
                  <h2 className="font-display text-xl font-bold text-ink">{locale === 'ar' ? plan.nameAr : plan.nameEn}</h2>
                </div>

                <div className="mb-6 flex items-baseline gap-2">
                  <span className="font-display text-4xl font-extrabold tabular-nums text-ink">
                    {locale === 'ar' ? plan.priceAr : plan.priceEn}
                  </span>
                  <span className="font-semibold text-ink-muted">{locale === 'ar' ? plan.currencyAr : plan.currencyEn}</span>
                </div>

                <p className="mb-8 min-h-12 leading-relaxed text-ink-muted">
                  {locale === 'ar' ? plan.descAr : plan.descEn}
                </p>

                <Link
                  href="/auth/register"
                  className={`${buttonClass(plan.popular ? "accent" : "secondary", "lg")} mb-8 w-full`}
                >
                  {locale === 'ar' ? plan.ctaAr : plan.ctaEn}
                </Link>

                <div className="space-y-4">
                  {(locale === 'ar' ? plan.featuresAr : plan.featuresEn).map((feature, j) => (
                    <div key={j} className="flex items-center gap-3">
                      <span aria-hidden="true" className="flex size-6 shrink-0 items-center justify-center rounded-full bg-success-bg text-success-ink">
                        <Check size={14} strokeWidth={3} />
                      </span>
                      <span className="text-ink">{feature}</span>
                    </div>
                  ))}
                </div>

             </Card>
           ))}
        </div>

      </div>
    </div>
  );
}
