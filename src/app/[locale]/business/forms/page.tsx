"use client";

import { useLocale } from "next-intl";
import { useState, useEffect } from "react";
import { Plus, Save, Phone, Mail, Calendar, User, CheckCircle, AlertCircle, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

interface FieldConfig {
  enabled: boolean;
  required: boolean;
}

interface FormFields {
  firstName: FieldConfig;
  lastName: FieldConfig;
  phone: FieldConfig;
  email: FieldConfig;
  dob: FieldConfig;
}

const DEFAULT_FIELDS: FormFields = {
  firstName: { enabled: true, required: true },
  lastName: { enabled: true, required: false },
  phone: { enabled: true, required: true },
  email: { enabled: false, required: false },
  dob: { enabled: false, required: false },
};

export default function FormsBuilderPage() {
  const locale = useLocale();
  const dir = locale === 'ar' ? 'rtl' : 'ltr';
  const isAr = locale === 'ar';

  const [fields, setFields] = useState<FormFields>(DEFAULT_FIELDS);
  const [isSaving, setIsSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    fetch('/api/forms/settings')
      .then(r => r.json())
      .then(data => {
        if (data.settings && Object.keys(data.settings).length > 0) {
          setFields(data.settings);
        }
        setIsLoading(false);
      })
      .catch(() => setIsLoading(false));
  }, []);

  const handleSave = async () => {
    setIsSaving(true);
    setSaveStatus('idle');
    try {
      const res = await fetch('/api/forms/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fields),
      });
      if (res.ok) setSaveStatus('success');
      else setSaveStatus('error');
    } catch {
      setSaveStatus('error');
    } finally {
      setIsSaving(false);
    }
  };

  const toggleField = (key: keyof FormFields, property: 'enabled' | 'required') => {
    // Prevent disabling mandatory fields
    if (key === 'firstName' || key === 'phone') return;
    
    setFields(prev => ({
      ...prev,
      [key]: { ...prev[key], [property]: !prev[key][property] }
    }));
    setSaveStatus('idle');
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950 flex items-center justify-center">
        <Loader2 className="w-10 h-10 animate-spin text-zinc-400" />
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-8 min-h-screen bg-zinc-50 dark:bg-zinc-950 font-sans" dir={dir}>
      <div className="max-w-7xl mx-auto">
        
        {/* Header */}
        <div className="mb-10 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
           <div>
              <h1 className="text-4xl font-black tracking-tight text-zinc-900 dark:text-zinc-100">
                {isAr ? 'نماذج إصدار البطاقات' : 'Enrollment Forms'}
              </h1>
              <p className="text-zinc-500 mt-2 text-lg font-medium">
                {isAr ? 'قم بخصيص البيانات المطلوبة من العميل قبل تحميل البطاقة' : 'Customize the data collection form for cardholders.'}
              </p>
           </div>
           <div className="flex items-center gap-4">
              {saveStatus === 'success' && <p className="text-emerald-600 font-bold text-sm flex items-center gap-1"><CheckCircle size={16}/> {isAr ? 'تم الحفظ!' : 'Saved!'}</p>}
              <button 
                onClick={handleSave}
                disabled={isSaving}
                className="bg-zinc-900 hover:bg-zinc-800 dark:bg-white dark:hover:bg-zinc-100 text-white dark:text-zinc-900 px-6 py-3 rounded-2xl font-bold flex items-center gap-2 transition-all shadow-lg active:scale-95 disabled:opacity-50"
              >
                 {isSaving ? <Loader2 size={20} className="animate-spin" /> : <Save size={20} />}
                 {isAr ? 'حفظ النموذج' : 'Save Form'}
              </button>
           </div>
        </div>

        <div className="grid lg:grid-cols-2 gap-10 items-start">
           
           {/* Builder Panel */}
           <div className="bg-white dark:bg-zinc-900 rounded-[2.5rem] border border-zinc-200 dark:border-zinc-800 p-8 shadow-xl">
              <h2 className="text-2xl font-bold mb-6 text-zinc-900 dark:text-zinc-100">{isAr ? 'الحقول القياسية' : 'Standard Fields'}</h2>
              
              <div className="space-y-4">
                 
                 {/* First Name */}
                 <div className="flex items-center justify-between p-4 bg-zinc-50 dark:bg-zinc-950 rounded-2xl border border-zinc-200 dark:border-zinc-800 opacity-70">
                    <div className="flex items-center gap-4">
                       <div className="w-10 h-10 rounded-xl bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-400 flex items-center justify-center"><User size={20} /></div>
                       <div><div className="font-bold text-zinc-900 dark:text-zinc-100">{isAr ? 'الاسم الأول' : 'First Name'}</div></div>
                    </div>
                    <div className="flex items-center gap-4">
                       <span className="text-xs font-bold text-zinc-400">{isAr ? 'إلزامي دائماً' : 'Always Required'}</span>
                    </div>
                 </div>

                 {/* Last Name */}
                 <div className="flex items-center justify-between p-4 bg-zinc-50 dark:bg-zinc-950 rounded-2xl border border-zinc-200 dark:border-zinc-800">
                    <div className="flex items-center gap-4">
                       <div className="w-10 h-10 rounded-xl bg-indigo-100 dark:bg-indigo-900/40 text-indigo-600 dark:text-indigo-400 flex items-center justify-center"><User size={20} /></div>
                       <div><div className="font-bold text-zinc-900 dark:text-zinc-100">{isAr ? 'اسم العائلة' : 'Last Name'}</div></div>
                    </div>
                    <div className="flex items-center gap-6">
                       <div className="flex items-center gap-2">
                          <label className="text-xs font-bold text-zinc-500">{isAr ? 'تفعيل؟' : 'Enable?'}</label>
                          <input type="checkbox" checked={fields.lastName.enabled} onChange={() => toggleField('lastName', 'enabled')} className="w-5 h-5 rounded accent-indigo-600" />
                       </div>
                       <div className="flex items-center gap-2">
                          <label className="text-xs font-bold text-zinc-500">{isAr ? 'مطلوب؟' : 'Req?'}</label>
                          <input type="checkbox" checked={fields.lastName.required} onChange={() => toggleField('lastName', 'required')} disabled={!fields.lastName.enabled} className="w-4 h-4 rounded accent-zinc-900" />
                       </div>
                    </div>
                 </div>

                 {/* Phone */}
                 <div className="flex items-center justify-between p-4 bg-zinc-50 dark:bg-zinc-950 rounded-2xl border border-zinc-200 dark:border-zinc-800 opacity-70">
                    <div className="flex items-center gap-4">
                       <div className="w-10 h-10 rounded-xl bg-emerald-100 dark:bg-emerald-900/40 text-emerald-600 dark:text-emerald-400 flex items-center justify-center"><Phone size={20} /></div>
                       <div><div className="font-bold text-zinc-900 dark:text-zinc-100">{isAr ? 'رقم الهاتف' : 'Phone Number'}</div></div>
                    </div>
                    <div className="flex items-center gap-4">
                       <span className="text-xs font-bold text-zinc-400">{isAr ? 'إلزامي دائماً' : 'Always Required'}</span>
                    </div>
                 </div>

                 {/* Email */}
                 <div className="flex items-center justify-between p-4 bg-zinc-50 dark:bg-zinc-950 rounded-2xl border border-zinc-200 dark:border-zinc-800">
                    <div className="flex items-center gap-4">
                       <div className="w-10 h-10 rounded-xl bg-amber-100 dark:bg-amber-900/40 text-amber-600 dark:text-amber-400 flex items-center justify-center"><Mail size={20} /></div>
                       <div><div className="font-bold text-zinc-900 dark:text-zinc-100">{isAr ? 'البريد الإلكتروني' : 'Email Address'}</div></div>
                    </div>
                    <div className="flex items-center gap-6">
                       <div className="flex items-center gap-2">
                          <label className="text-xs font-bold text-zinc-500">{isAr ? 'تفعيل؟' : 'Enable?'}</label>
                          <input type="checkbox" checked={fields.email.enabled} onChange={() => toggleField('email', 'enabled')} className="w-5 h-5 rounded accent-amber-600" />
                       </div>
                       <div className="flex items-center gap-2">
                          <label className="text-xs font-bold text-zinc-500">{isAr ? 'مطلوب؟' : 'Req?'}</label>
                          <input type="checkbox" checked={fields.email.required} onChange={() => toggleField('email', 'required')} disabled={!fields.email.enabled} className="w-4 h-4 rounded accent-zinc-900" />
                       </div>
                    </div>
                 </div>

                 {/* DOB */}
                 <div className="flex items-center justify-between p-4 bg-zinc-50 dark:bg-zinc-950 rounded-2xl border border-zinc-200 dark:border-zinc-800">
                    <div className="flex items-center gap-4">
                       <div className="w-10 h-10 rounded-xl bg-rose-100 dark:bg-rose-900/40 text-rose-600 dark:text-rose-400 flex items-center justify-center"><Calendar size={20} /></div>
                       <div><div className="font-bold text-zinc-900 dark:text-zinc-100">{isAr ? 'تاريخ الميلاد' : 'Date of Birth'}</div></div>
                    </div>
                    <div className="flex items-center gap-6">
                       <div className="flex items-center gap-2">
                          <label className="text-xs font-bold text-zinc-500">{isAr ? 'تفعيل؟' : 'Enable?'}</label>
                          <input type="checkbox" checked={fields.dob.enabled} onChange={() => toggleField('dob', 'enabled')} className="w-5 h-5 rounded accent-rose-600" />
                       </div>
                    </div>
                 </div>

              </div>

              <div className="mt-8 pt-8 border-t border-zinc-200 dark:border-zinc-800">
                 <button className="w-full py-4 border-2 border-dashed border-zinc-300 dark:border-zinc-700 text-zinc-500 dark:text-zinc-400 rounded-2xl font-bold flex items-center justify-center gap-2 hover:bg-zinc-50 dark:hover:bg-zinc-800/50 transition-colors">
                    <Plus size={20} />
                    {isAr ? 'إضافة حقل مخصص' : 'Add Custom Input Field'}
                 </button>
              </div>
           </div>

           {/* Mobile Preview */}
           <div className="flex justify-center sticky top-8">
              <div className="w-[360px] h-[720px] bg-zinc-900 rounded-[3rem] p-3 shadow-2xl relative border-[6px] border-zinc-800">
                 <div className="absolute top-0 left-1/2 -translate-x-1/2 w-32 h-6 bg-zinc-800 rounded-b-xl z-20"></div>
                 <div className="w-full h-full bg-white rounded-[2.2rem] overflow-hidden flex flex-col relative text-zinc-900 p-6 pt-12">
                    <div className="w-14 h-14 bg-blue-600 text-white rounded-2xl flex items-center justify-center text-xl font-black shadow-lg mx-auto mb-6">W</div>
                    <h3 className="text-xl font-black text-center mb-2">{isAr ? 'انضم لبرنامج الولاء' : 'Card Enrollment'}</h3>
                    <p className="text-[10px] font-bold text-zinc-400 text-center mb-8">{isAr ? 'يرجى إكمال بياناتك لإصدار بطاقتك الرقمية' : 'Complete your profile to issue your card.'}</p>
                    <div className="space-y-4 overflow-y-auto pb-6">
                       <div className="space-y-1">
                          <label className="text-[10px] font-bold uppercase tracking-wider text-zinc-400">{isAr ? 'الاسم الأول' : 'First Name'} *</label>
                          <input type="text" disabled placeholder="..." className="w-full border-2 border-zinc-50 rounded-xl px-4 py-2 bg-zinc-50 text-xs" />
                       </div>
                       {fields.lastName.enabled && (
                          <div className="space-y-1">
                             <label className="text-[10px] font-bold uppercase tracking-wider text-zinc-400">{isAr ? 'اسم العائلة' : 'Last Name'} {fields.lastName.required && '*'}</label>
                             <input type="text" disabled placeholder="..." className="w-full border-2 border-zinc-50 rounded-xl px-4 py-2 bg-zinc-50 text-xs" />
                          </div>
                       )}
                       <div className="space-y-1">
                          <label className="text-[10px] font-bold uppercase tracking-wider text-zinc-400">{isAr ? 'رقم الجوال' : 'Phone'} *</label>
                          <input type="text" disabled placeholder="+963..." className="w-full border-2 border-zinc-50 rounded-xl px-4 py-2 bg-zinc-50 text-xs" />
                       </div>
                       {fields.email.enabled && (
                          <div className="space-y-1">
                             <label className="text-[10px] font-bold uppercase tracking-wider text-zinc-400">{isAr ? 'البريد' : 'Email'} {fields.email.required && '*'}</label>
                             <input type="email" disabled placeholder="..." className="w-full border-2 border-zinc-50 rounded-xl px-4 py-2 bg-zinc-50 text-xs" />
                          </div>
                       )}
                       {fields.dob.enabled && (
                          <div className="space-y-1">
                             <label className="text-[10px] font-bold uppercase tracking-wider text-zinc-400">{isAr ? 'تاريخ الميلاد' : 'Date of Birth'}</label>
                             <input type="date" disabled className="w-full border-2 border-zinc-50 rounded-xl px-4 py-2 bg-zinc-50 text-xs text-zinc-400" />
                          </div>
                       )}
                       <button className="w-full bg-blue-600 text-white font-black text-sm py-4 rounded-xl mt-4">
                          {isAr ? 'أصدر بطاقتي' : 'Issue Card'}
                       </button>
                    </div>
                 </div>
              </div>
           </div>

        </div>
      </div>
    </div>
  );
}
