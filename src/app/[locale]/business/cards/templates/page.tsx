"use client";

import { useLocale } from "next-intl";
import Link from "next/link";
import { Coffee, Scissors, Dumbbell, CarFront, Utensils, ShoppingBag, ArrowRight } from "lucide-react";

export default function TemplatesPage() {
  const locale = useLocale();
  const dir = locale === 'ar' ? 'rtl' : 'ltr';

  // Boomerangme-style starting templates
  const templates = [
    {
       id: 'cafe_stamp',
       icon: Coffee,
       color: 'bg-amber-600',
       titleEn: 'Coffee Shop (10 Stamps)',
       titleAr: 'مقهى (10 أختام)',
       descEn: 'Buy 9 Coffees, get the 10th free. Perfect for daily retention.',
       descAr: 'اشتر 9 أكواب قهوة واحصل على العاشر مجاناً.',
       typeEn: 'Stamp Card',
       typeAr: 'بطاقة أختام'
    },
    {
       id: 'barber_cashback',
       icon: Scissors,
       color: 'bg-zinc-900',
       titleEn: 'Barbershop (5% Cashback)',
       titleAr: 'صالون حلاقة (5% استرداد نقدي)',
       descEn: 'Build loyalty by offering flat 5% wallet cashback on all haircuts.',
       descAr: 'قدم 5% استرداد نقدي في المحفظة على جميع الخدمات.',
       typeEn: 'Cashback',
       typeAr: 'استرداد نقدي'
    },
    {
       id: 'gym_multipass',
       icon: Dumbbell,
       color: 'bg-blue-600',
       titleEn: 'Fitness Center (12 Sessions)',
       titleAr: 'نادي رياضي (12 حصة مسبقة الدفع)',
       descEn: 'Prepaid multipass. Automatically deducts 1 session per scan.',
       descAr: 'اشتراك مسبق الدفع يخصم حصة واحدة عند كل زيارة.',
       typeEn: 'Subscription',
       typeAr: 'اشتراك'
    },
    {
       id: 'carwash_stamp',
       icon: CarFront,
       color: 'bg-cyan-600',
       titleEn: 'Car Wash (5 Stamps)',
       titleAr: 'مغسلة سيارات (5 أختام)',
       descEn: 'Short loop cycle. 4 washes, 5th wash is a free premium wax.',
       descAr: 'دورة سريعة: اغسل 4 مرات والخامسة غسيل VIP مجاني.',
       typeEn: 'Stamp Card',
       typeAr: 'بطاقة أختام'
    },
    {
       id: 'restaurant_discount',
       icon: Utensils,
       color: 'bg-rose-600',
       titleEn: 'Restaurant (15% VIP Discount)',
       titleAr: 'مطعم (15% خصم مباشر)',
       descEn: 'Exclusive digital membership for a flat 15% discount on dining.',
       descAr: 'بطاقة عضوية رقمية تمنح خصم 15% على جميع الطلبات المحلية.',
       typeEn: 'Discount',
       typeAr: 'خصم ثابت'
    },
    {
       id: 'retail_gift',
       icon: ShoppingBag,
       color: 'bg-emerald-600',
       titleEn: 'Retail Store (50K SYP Gift)',
       titleAr: 'متجر (بطاقة هدية 50 ألف ل.س)',
       descEn: 'A preloaded gift card customers can send to their friends.',
       descAr: 'بطاقة هدية رقمية مشحونة مسبقاً قابلة للإهداء عبر الواتساب.',
       typeEn: 'Gift Card',
       typeAr: 'بطاقة هدايا'
    }
  ];

  return (
    <div className="p-4 sm:p-8 min-h-screen bg-zinc-50 dark:bg-zinc-950 font-sans" dir={dir}>
      <div className="max-w-7xl mx-auto">
        
        <div className="mb-10 text-center max-w-2xl mx-auto">
           <h1 className="text-4xl font-black tracking-tight text-zinc-900 dark:text-zinc-100">
             {locale === 'ar' ? 'مكتبة قوالب البطاقات (Templates)' : 'Card Templates Library'}
           </h1>
           <p className="text-zinc-500 mt-4 text-lg font-medium leading-relaxed">
             {locale === 'ar' 
               ? 'لا تبدأ من الصفر. اختر أحد قوالب الصناعات الجاهزة والتي تم تصميمها بناءً على أنجح برامج الولاء العالمية، وقم بتعديلها بضغطة زر.' 
               : 'Don\'t start from scratch. Choose a pre-configured template optimized for your specific industry and customize it in 1-Click.'}
           </p>
        </div>

        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
           {templates.map((tpl) => (
              <div key={tpl.id} className="bg-white dark:bg-zinc-900 rounded-[2rem] p-6 border border-zinc-200 dark:border-zinc-800 shadow-lg hover:shadow-2xl transition-all group overflow-hidden relative flex flex-col h-full">
                 
                 {/* Card Type Badge */}
                 <div className="absolute top-6 end-6 bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 text-xs font-black uppercase tracking-widest px-3 py-1.5 rounded-full z-10">
                    {locale === 'ar' ? tpl.typeAr : tpl.typeEn}
                 </div>

                 <div className={`w-16 h-16 rounded-2xl ${tpl.color} text-white flex items-center justify-center mb-6 shadow-md transition-transform group-hover:scale-110`}>
                    <tpl.icon size={32} />
                 </div>

                 <h3 className="text-xl font-black text-zinc-900 dark:text-zinc-100 mb-2">
                    {locale === 'ar' ? tpl.titleAr : tpl.titleEn}
                 </h3>
                 
                 <p className="text-zinc-500 font-medium text-sm leading-relaxed mb-8 flex-1">
                    {locale === 'ar' ? tpl.descAr : tpl.descEn}
                 </p>

                 <Link 
                    href={`/${locale}/business/cards/builder?template=${tpl.id}`}
                    className="w-full bg-zinc-50 hover:bg-zinc-100 dark:bg-zinc-950 dark:hover:bg-zinc-800 border border-zinc-200 dark:border-zinc-800 text-zinc-900 dark:text-zinc-100 py-4 rounded-xl font-bold flex items-center justify-center gap-2 transition-colors group/btn mt-auto"
                 >
                    {locale === 'ar' ? 'استخدام القالب' : 'Use Template'}
                    <ArrowRight size={18} className="transition-transform group-hover/btn:translate-x-1 rtl:group-hover/btn:-translate-x-1" />
                 </Link>
              </div>
           ))}
        </div>

      </div>
    </div>
  );
}
