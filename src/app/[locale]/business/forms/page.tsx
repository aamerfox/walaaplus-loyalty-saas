"use client";

import { useLocale } from "next-intl";
import { useState } from "react";
import { Copy, Plus, Save, Phone, Mail, Calendar, User, Trash2 } from "lucide-react";

export default function FormsBuilderPage() {
  const locale = useLocale();
  const dir = locale === 'ar' ? 'rtl' : 'ltr';

  // Toggle states for standard fields
  const [fields, setFields] = useState({
    firstName: { enabled: true, required: true },
    lastName: { enabled: true, required: false },
    phone: { enabled: true, required: true },
    email: { enabled: false, required: false },
    dob: { enabled: false, required: false },
  });

  return (
    <div className="p-4 sm:p-8 min-h-screen bg-zinc-50 dark:bg-zinc-950 font-sans" dir={dir}>
      <div className="max-w-7xl mx-auto">
        
        {/* Header Setup */}
        <div className="mb-10 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
           <div>
              <h1 className="text-4xl font-black tracking-tight text-zinc-900 dark:text-zinc-100">
                {locale === 'ar' ? 'نماذج إصدار البطاقات' : 'Card Installation Forms'}
              </h1>
              <p className="text-zinc-500 mt-2 text-lg font-medium">
                {locale === 'ar' ? 'قم بتخصيص البيانات المطلوبة من العميل قبل تحميل البطاقة إلى Wallet' : 'Customize the data collection form requested before issuing the card.'}
              </p>
           </div>
           <button className="bg-zinc-900 hover:bg-zinc-800 dark:bg-white dark:hover:bg-zinc-100 text-white dark:text-zinc-900 px-6 py-3 rounded-2xl font-bold flex items-center gap-2 transition-all shadow-lg active:scale-95">
              <Save size={20} />
              {locale === 'ar' ? 'حفظ النموذج' : 'Save Form'}
           </button>
        </div>

        <div className="grid lg:grid-cols-2 gap-10 items-start">
           
           {/* Builder Panel */}
           <div className="bg-white dark:bg-zinc-900 rounded-[2.5rem] border border-zinc-200 dark:border-zinc-800 p-8 shadow-xl">
              <h2 className="text-2xl font-bold mb-6 text-zinc-900 dark:text-zinc-100">
                 {locale === 'ar' ? 'الحقول القياسية (Standard Fields)' : 'Standard Fields'}
              </h2>
              
              <div className="space-y-4">
                 
                 {/* First Name */}
                 <div className="flex items-center justify-between p-4 bg-zinc-50 dark:bg-zinc-950 rounded-2xl border border-zinc-200 dark:border-zinc-800">
                    <div className="flex items-center gap-4">
                       <div className="w-10 h-10 rounded-xl bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-400 flex items-center justify-center">
                          <User size={20} />
                       </div>
                       <div>
                          <div className="font-bold text-zinc-900 dark:text-zinc-100">{locale === 'ar' ? 'الاسم الأول' : 'First Name'}</div>
                          <div className="text-xs text-zinc-500 mt-0.5">{locale === 'ar' ? 'مطلوب إجبارياً لإصدار البطاقة باسم العميل' : 'Mandatory for personalized mapping'}</div>
                       </div>
                    </div>
                    <div className="flex items-center gap-4">
                       <label className="text-xs font-bold text-zinc-500">{locale === 'ar' ? 'مطلوب؟' : 'Required?'}</label>
                       <input type="checkbox" checked disabled className="w-5 h-5 rounded rounded-md accent-zinc-900 cursor-not-allowed opacity-50" />
                    </div>
                 </div>

                 {/* Last Name */}
                 <div className="flex items-center justify-between p-4 bg-zinc-50 dark:bg-zinc-950 rounded-2xl border border-zinc-200 dark:border-zinc-800">
                    <div className="flex items-center gap-4">
                       <div className="w-10 h-10 rounded-xl bg-indigo-100 dark:bg-indigo-900/40 text-indigo-600 dark:text-indigo-400 flex items-center justify-center">
                          <User size={20} />
                       </div>
                       <div>
                          <div className="font-bold text-zinc-900 dark:text-zinc-100">{locale === 'ar' ? 'اسم العائلة' : 'Last Name'}</div>
                       </div>
                    </div>
                    <div className="flex items-center gap-4">
                       <label className="text-xs font-bold text-zinc-500">{locale === 'ar' ? 'تفعيل؟' : 'Enable?'}</label>
                       <input type="checkbox" checked={fields.lastName.enabled} onChange={(e) => setFields({...fields, lastName: {...fields.lastName, enabled: e.target.checked}})} className="w-5 h-5 rounded rounded-md accent-indigo-600" />
                    </div>
                 </div>

                 {/* Phone */}
                 <div className="flex items-center justify-between p-4 bg-zinc-50 dark:bg-zinc-950 rounded-2xl border border-zinc-200 dark:border-zinc-800">
                    <div className="flex items-center gap-4">
                       <div className="w-10 h-10 rounded-xl bg-emerald-100 dark:bg-emerald-900/40 text-emerald-600 dark:text-emerald-400 flex items-center justify-center">
                          <Phone size={20} />
                       </div>
                       <div>
                          <div className="font-bold text-zinc-900 dark:text-zinc-100">{locale === 'ar' ? 'رقم الهاتف (مع التوثيق)' : 'Phone Number (Verified)'}</div>
                       </div>
                    </div>
                    <div className="flex items-center gap-4">
                       <label className="text-xs font-bold text-zinc-500">{locale === 'ar' ? 'مطلوب؟' : 'Required?'}</label>
                       <input type="checkbox" checked disabled className="w-5 h-5 rounded rounded-md accent-zinc-900 cursor-not-allowed opacity-50" />
                    </div>
                 </div>

                 {/* Email */}
                 <div className="flex items-center justify-between p-4 bg-zinc-50 dark:bg-zinc-950 rounded-2xl border border-zinc-200 dark:border-zinc-800 transition-all opacity-100 peer">
                    <div className="flex items-center gap-4">
                       <div className="w-10 h-10 rounded-xl bg-amber-100 dark:bg-amber-900/40 text-amber-600 dark:text-amber-400 flex items-center justify-center">
                          <Mail size={20} />
                       </div>
                       <div>
                          <div className="font-bold text-zinc-900 dark:text-zinc-100">{locale === 'ar' ? 'البريد الإلكتروني' : 'Email Address'}</div>
                       </div>
                    </div>
                    <div className="flex items-center gap-4">
                       <label className="text-xs font-bold text-zinc-500">{locale === 'ar' ? 'تفعيل؟' : 'Enable?'}</label>
                       <input type="checkbox" checked={fields.email.enabled} onChange={(e) => setFields({...fields, email: {...fields.email, enabled: e.target.checked}})} className="w-5 h-5 rounded rounded-md accent-amber-600" />
                    </div>
                 </div>

                 {/* DOB */}
                 <div className="flex items-center justify-between p-4 bg-zinc-50 dark:bg-zinc-950 rounded-2xl border border-zinc-200 dark:border-zinc-800">
                    <div className="flex items-center gap-4">
                       <div className="w-10 h-10 rounded-xl bg-rose-100 dark:bg-rose-900/40 text-rose-600 dark:text-rose-400 flex items-center justify-center">
                          <Calendar size={20} />
                       </div>
                       <div>
                          <div className="font-bold text-zinc-900 dark:text-zinc-100">{locale === 'ar' ? 'تاريخ الميلاد' : 'Date of Birth'}</div>
                          <div className="text-xs text-zinc-500 mt-0.5">{locale === 'ar' ? 'يُستخدم لإرسال أتمتة تهنئة عيد الميلاد' : 'Used for Birthday Push Automations'}</div>
                       </div>
                    </div>
                    <div className="flex items-center gap-4">
                       <label className="text-xs font-bold text-zinc-500">{locale === 'ar' ? 'تفعيل؟' : 'Enable?'}</label>
                       <input type="checkbox" checked={fields.dob.enabled} onChange={(e) => setFields({...fields, dob: {...fields.dob, enabled: e.target.checked}})} className="w-5 h-5 rounded rounded-md accent-rose-600" />
                    </div>
                 </div>

              </div>

              <div className="mt-8 pt-8 border-t border-zinc-200 dark:border-zinc-800">
                 <button className="w-full py-4 border-2 border-dashed border-zinc-300 dark:border-zinc-700 text-zinc-500 dark:text-zinc-400 rounded-2xl font-bold flex items-center justify-center gap-2 hover:bg-zinc-50 dark:hover:bg-zinc-800/50 transition-colors">
                    <Plus size={20} />
                    {locale === 'ar' ? 'إضافة حقل مخصص (Custom Field +)' : 'Add Custom Input Field'}
                 </button>
              </div>

           </div>

           {/* Mobile Preview Panel */}
           <div className="flex justify-center sticky top-8">
              <div className="w-[380px] h-[780px] bg-zinc-900 rounded-[3rem] p-3 shadow-2xl relative border-[6px] border-zinc-800">
                 {/* Notch */}
                 <div className="absolute top-0 left-1/2 -translate-x-1/2 w-32 h-6 bg-zinc-800 rounded-b-xl z-20"></div>

                 {/* Screen */}
                 <div className="w-full h-full bg-white rounded-[2.2rem] overflow-hidden flex flex-col relative text-zinc-900 p-6 pt-12">
                    <div className="w-16 h-16 bg-blue-600 text-white rounded-2xl flex items-center justify-center text-2xl font-black shadow-lg mx-auto mb-6">W</div>
                    
                    <h3 className="text-2xl font-black text-center mb-2">{locale === 'ar' ? 'أهلاً بك في نظام الولاء' : 'Card Installation'}</h3>
                    <p className="text-sm font-medium text-zinc-500 text-center mb-8">
                      {locale === 'ar' ? 'يرجى إكمال بياناتك لإصدار بطاقتك الرقمية للحصول على المكافآت' : 'Please complete your profile to issue your digital wallet card.'}
                    </p>

                    <div className="space-y-4 overflow-y-auto pb-6">
                       <div className="space-y-2">
                          <label className="text-xs font-bold uppercase tracking-wider text-zinc-400">{locale === 'ar' ? 'الاسم الأول' : 'First Name'} *</label>
                          <input type="text" disabled placeholder={locale === 'ar' ? 'أدخل اسمك الأول' : 'Enter first name'} className="w-full border-2 border-zinc-100 rounded-xl px-4 py-3 bg-zinc-50" />
                       </div>
                       
                       {fields.lastName.enabled && (
                          <div className="space-y-2">
                             <label className="text-xs font-bold uppercase tracking-wider text-zinc-400">{locale === 'ar' ? 'اسم العائلة' : 'Last Name'}</label>
                             <input type="text" disabled placeholder={locale === 'ar' ? 'أدخل اسم العائلة' : 'Enter last name'} className="w-full border-2 border-zinc-100 rounded-xl px-4 py-3 bg-zinc-50" />
                          </div>
                       )}

                       <div className="space-y-2">
                          <label className="text-xs font-bold uppercase tracking-wider text-zinc-400">{locale === 'ar' ? 'رقم الجوال' : 'Phone Number'} *</label>
                          <div className="flex gap-2">
                             <div className="w-20 bg-zinc-50 border-2 border-zinc-100 rounded-xl flex items-center justify-center font-bold font-mono">+963</div>
                             <input type="text" disabled placeholder="9xx xxx xxx" className="flex-1 border-2 border-zinc-100 rounded-xl px-4 py-3 bg-zinc-50" />
                          </div>
                          <p className="text-[10px] text-zinc-500 font-bold">{locale === 'ar' ? 'سيتم إرسال كود تفعيل SMS للتحقق' : 'An OTP will be sent via SMS'}</p>
                       </div>

                       {fields.email.enabled && (
                          <div className="space-y-2">
                             <label className="text-xs font-bold uppercase tracking-wider text-zinc-400">{locale === 'ar' ? 'البريد الإلكتروني' : 'Email'}</label>
                             <input type="email" disabled placeholder={locale === 'ar' ? 'name@example.com' : 'name@example.com'} className="w-full border-2 border-zinc-100 rounded-xl px-4 py-3 bg-zinc-50" />
                          </div>
                       )}

                       {fields.dob.enabled && (
                          <div className="space-y-2">
                             <label className="text-xs font-bold uppercase tracking-wider text-zinc-400">{locale === 'ar' ? 'تاريخ الميلاد' : 'Date of Birth'}</label>
                             <input type="date" disabled className="w-full border-2 border-zinc-100 rounded-xl px-4 py-3 bg-zinc-50 text-zinc-400" />
                          </div>
                       )}

                       <button className="w-full bg-blue-600 text-white font-black text-lg py-4 rounded-xl mt-4 shadow-xl shadow-blue-600/30">
                          {locale === 'ar' ? 'أصدر بطاقتي الآن' : 'Issue My Card'}
                       </button>

                       <p className="text-[10px] text-center text-zinc-400 font-bold mt-4 leading-relaxed">
                          {locale === 'ar' ? 'بالموافقة، أنت توافق على الشروط والأحكام و سياسة بيانات ولاء بلس.' : 'By issuing, you agree to WalaaPlus Data Policies.'}
                       </p>
                    </div>
                 </div>
              </div>
           </div>

        </div>
      </div>
    </div>
  );
}
