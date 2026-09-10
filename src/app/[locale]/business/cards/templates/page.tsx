"use client";

import { useLocale } from "next-intl";
import Link from "next/link";
import { useState, useEffect } from "react";
import { Plus, CreditCard, Trash2, Eye } from "lucide-react";

const TYPE_COLORS: Record<string, string> = {
  STAMP: 'bg-indigo-500',
  CASHBACK: 'bg-emerald-600',
  DISCOUNT: 'bg-amber-500',
  SUBSCRIPTION: 'bg-blue-600',
  GIFT: 'bg-pink-600',
  COUPON: 'bg-rose-600',
};

const TYPE_LABELS_AR: Record<string, string> = {
  STAMP: 'أختام',
  CASHBACK: 'استرداد نقدي',
  DISCOUNT: 'خصم ثابت',
  SUBSCRIPTION: 'اشتراك',
  GIFT: 'بطاقة هدية',
  COUPON: 'كوبون',
};

export default function MyCardsPage() {
  const locale = useLocale();
  const dir = locale === 'ar' ? 'rtl' : 'ltr';
  const [cards, setCards] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/cards')
      .then(r => r.json())
      .then(data => setCards(data.cards || []))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="p-4 sm:p-8 min-h-screen bg-zinc-50 dark:bg-zinc-950 font-sans" dir={dir}>
      <div className="max-w-7xl mx-auto">

        <div className="flex items-center justify-between mb-10">
          <div>
            <h1 className="text-3xl font-black tracking-tight text-zinc-900 dark:text-zinc-100">
              {locale === 'ar' ? 'بطاقاتي' : 'My Cards'}
            </h1>
            <p className="text-zinc-500 mt-1 font-medium">
              {locale === 'ar' ? 'إدارة وإطلاق برامج الولاء والمكافآت لعملائك' : 'Manage and publish your loyalty programs'}
            </p>
          </div>
          <Link
            href={`/${locale}/business/cards/builder`}
            className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white font-bold px-5 py-3 rounded-xl shadow-lg shadow-indigo-600/20 transition-transform hover:scale-105"
          >
            <Plus size={18} />
            {locale === 'ar' ? 'بطاقة جديدة' : 'New Card'}
          </Link>
        </div>

        {loading ? (
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {[1,2,3].map(i => (
              <div key={i} className="bg-white dark:bg-zinc-900 rounded-[2rem] h-48 animate-pulse border border-zinc-200 dark:border-zinc-800" />
            ))}
          </div>
        ) : cards.length === 0 ? (
          <div className="text-center py-24">
            <div className="w-20 h-20 bg-indigo-50 dark:bg-indigo-500/10 rounded-3xl flex items-center justify-center mx-auto mb-6">
              <CreditCard size={36} className="text-indigo-400" />
            </div>
            <h2 className="text-2xl font-black text-zinc-900 dark:text-zinc-100 mb-3">
              {locale === 'ar' ? 'لا توجد بطاقات بعد' : 'No cards yet'}
            </h2>
            <p className="text-zinc-500 font-medium mb-8">
              {locale === 'ar' ? 'ابدأ بإنشاء أول بطاقة ولاء لعملائك الآن!' : 'Start by creating your first loyalty card!'}
            </p>
            <Link
              href={`/${locale}/business/cards/builder`}
              className="inline-flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white font-bold px-6 py-3 rounded-xl shadow-lg shadow-indigo-600/20 transition-transform hover:scale-105"
            >
              <Plus size={18} />
              {locale === 'ar' ? 'إنشاء بطاقة الآن' : 'Create Card Now'}
            </Link>
          </div>
        ) : (
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {cards.map((card: any) => {
              const design = card.design as any;
              const rules = card.rules as any;
              return (
                <div key={card.id} className="bg-white dark:bg-zinc-900 rounded-[2rem] p-6 border border-zinc-200 dark:border-zinc-800 shadow-lg hover:shadow-2xl transition-all group flex flex-col">

                  {/* Card Preview Header */}
                  <div className="h-28 rounded-2xl mb-5 flex items-center justify-between px-6" style={{ backgroundColor: design?.primaryColor || '#4f46e5' }}>
                    <div className="w-14 h-14 bg-white/20 rounded-2xl flex items-center justify-center font-black text-2xl text-white backdrop-blur-sm">W</div>
                    <span className={`px-3 py-1 rounded-full text-xs font-black text-white bg-white/20 backdrop-blur-sm uppercase tracking-widest`}>
                      {locale === 'ar' ? (TYPE_LABELS_AR[card.type] || card.type) : card.type}
                    </span>
                  </div>

                  <h3 className="text-lg font-black text-zinc-900 dark:text-zinc-100 mb-1">{card.name}</h3>
                  <p className="text-sm text-zinc-500 font-medium mb-4 flex-1">
                    {card.type === 'STAMP' && `${rules?.stampsCount || 10} ${locale === 'ar' ? 'ختم مطلوب' : 'stamps required'}`}
                    {card.type === 'CASHBACK' && `${rules?.cashbackPercent || 5}% ${locale === 'ar' ? 'استرداد' : 'cashback'}`}
                    {card.type === 'DISCOUNT' && `${rules?.discountPercent || 20}% OFF`}
                    {card.type === 'SUBSCRIPTION' && (rules?.subscriptionItem || 'Subscription')}
                  </p>

                  <div className="flex gap-2 mt-auto pt-4 border-t border-zinc-100 dark:border-zinc-800">
                    <Link
                      href={`/${locale}/business/cards/builder?id=${card.id}`}
                      className="flex-1 flex items-center justify-center gap-1.5 bg-indigo-50 dark:bg-indigo-500/10 hover:bg-indigo-100 text-indigo-700 dark:text-indigo-400 font-bold py-2.5 rounded-xl text-sm transition-colors"
                    >
                      <Eye size={15} />
                      {locale === 'ar' ? 'معاينة' : 'Preview'}
                    </Link>
                    <div className={`px-3 py-2.5 rounded-xl text-xs font-black ${card.isActive ? 'bg-emerald-50 text-emerald-700' : 'bg-zinc-100 text-zinc-500'}`}>
                      {card.isActive ? (locale === 'ar' ? 'نشط' : 'Active') : (locale === 'ar' ? 'معطل' : 'Inactive')}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
