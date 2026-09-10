"use client";

import { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { useLocale } from "next-intl";
import { Loader2, User, Phone, Mail, Calendar, CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/utils";

export default function EnrollmentPage() {
  const params = useParams();
  const templateId = params.id as string;
  const locale = useLocale();
  const router = useRouter();
  const isAr = locale === 'ar';

  const [template, setTemplate] = useState<any>(null);
  const [formSettings, setFormSettings] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formData, setFormData] = useState({
    firstName: "",
    lastName: "",
    phone: "",
    email: "",
    dob: ""
  });

  useEffect(() => {
    fetch(`/api/cards/${templateId}`)
      .then(r => r.json())
      .then(data => {
        setTemplate(data.card);
        // Assuming business settings are attached or we fetch separately
        return fetch('/api/forms/settings'); // Simplified for this environment
      })
      .then(r => r.json())
      .then(data => {
        setFormSettings(data.settings);
        setIsLoading(false);
      })
      .catch(() => setIsLoading(false));
  }, [templateId]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    try {
      const res = await fetch(`/api/cards/${templateId}/enroll`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      });
      const data = await res.json();
      if (data.success) {
        router.push(`/${locale}/card/${data.cardId}`);
      }
    } catch (error) {
      console.error(error);
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950 flex items-center justify-center">
        <Loader2 className="w-10 h-10 animate-spin text-indigo-600" />
      </div>
    );
  }

  if (!template) return <div>Card not found</div>;

  const primaryColor = template.design?.primaryColor || "#4f46e5";

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950 flex flex-col items-center p-4 sm:p-8" dir={isAr ? 'rtl' : 'ltr'}>
      <div className="w-full max-w-md bg-white dark:bg-zinc-900 rounded-[2.5rem] shadow-2xl overflow-hidden border border-zinc-200 dark:border-zinc-800">
        
        <div className="p-8 text-center text-white" style={{ backgroundColor: primaryColor }}>
           <div className="w-20 h-20 bg-white/20 rounded-3xl flex items-center justify-center text-4xl font-black mb-4 mx-auto backdrop-blur-md shadow-inner">
             {template.name.charAt(0)}
           </div>
           <h1 className="text-2xl font-black tracking-tight">{template.name}</h1>
           <p className="text-white/80 font-medium mt-1">{isAr ? 'برنامج الولاء الرسمي' : 'Official Loyalty Program'}</p>
        </div>

        <form onSubmit={handleSubmit} className="p-8 space-y-6">
          <div className="space-y-4">
            
            {/* First Name */}
            <div className="space-y-1.5">
              <label className="text-sm font-bold text-zinc-500 flex items-center gap-2">
                <User size={16} /> {isAr ? 'الاسم الأول' : 'First Name'} *
              </label>
              <input 
                required
                value={formData.firstName}
                onChange={e => setFormData({...formData, firstName: e.target.value})}
                type="text" 
                placeholder="..." 
                className="w-full bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-2xl px-5 py-4 focus:ring-2 focus:ring-indigo-500 transition-all outline-none" 
              />
            </div>

            {/* Last Name */}
            {(formSettings?.lastName?.enabled !== false) && (
              <div className="space-y-1.5">
                <label className="text-sm font-bold text-zinc-500 flex items-center gap-2">
                  <User size={16} /> {isAr ? 'الكنية' : 'Last Name'} {formSettings?.lastName?.required && '*'}
                </label>
                <input 
                  required={formSettings?.lastName?.required}
                  value={formData.lastName}
                  onChange={e => setFormData({...formData, lastName: e.target.value})}
                  type="text" 
                  placeholder="..." 
                  className="w-full bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-2xl px-5 py-4 focus:ring-2 focus:ring-indigo-500 transition-all outline-none" 
                />
              </div>
            )}

            {/* Phone */}
            <div className="space-y-1.5">
              <label className="text-sm font-bold text-zinc-500 flex items-center gap-2">
                <Phone size={16} /> {isAr ? 'رقم الهاتف' : 'Phone Number'} *
              </label>
              <input 
                required
                value={formData.phone}
                onChange={e => setFormData({...formData, phone: e.target.value})}
                type="tel" 
                placeholder="09..." 
                className="w-full bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-2xl px-5 py-4 focus:ring-2 focus:ring-indigo-500 transition-all outline-none" 
              />
            </div>

            {/* Email */}
            {formSettings?.email?.enabled && (
              <div className="space-y-1.5">
                <label className="text-sm font-bold text-zinc-500 flex items-center gap-2">
                  <Mail size={16} /> {isAr ? 'البريد الإلكتروني' : 'Email Address'} {formSettings?.email?.required && '*'}
                </label>
                <input 
                  required={formSettings?.email?.required}
                  value={formData.email}
                  onChange={e => setFormData({...formData, email: e.target.value})}
                  type="email" 
                  placeholder="..." 
                  className="w-full bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-2xl px-5 py-4 focus:ring-2 focus:ring-indigo-500 transition-all outline-none" 
                />
              </div>
            )}

            {/* DOB */}
            {formSettings?.dob?.enabled && (
              <div className="space-y-1.5">
                <label className="text-sm font-bold text-zinc-500 flex items-center gap-2">
                  <Calendar size={16} /> {isAr ? 'تاريخ الميلاد' : 'Date of Birth'}
                </label>
                <input 
                  value={formData.dob}
                  onChange={e => setFormData({...formData, dob: e.target.value})}
                  type="date" 
                  className="w-full bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-2xl px-5 py-4 focus:ring-2 focus:ring-indigo-500 transition-all outline-none" 
                />
              </div>
            )}

          </div>

          <button 
            type="submit"
            disabled={isSubmitting}
            className="w-full py-5 bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 font-black rounded-3xl shadow-xl shadow-zinc-900/20 active:scale-95 transition-all text-lg flex items-center justify-center gap-3 disabled:opacity-50"
          >
            {isSubmitting ? (
              <Loader2 className="animate-spin" />
            ) : (
              <>
                <CheckCircle2 />
                {isAr ? 'اصدار بطاقتي الرقمية' : 'Issue My Digital Card'}
              </>
            )}
          </button>

          <p className="text-center text-[10px] text-zinc-400 font-bold uppercase tracking-widest mt-4">
             {isAr ? 'منصة ولاء بلس - جميع الحقوق محفوظة' : 'Secured by WalaaPlus Platform'}
          </p>
        </form>
      </div>
    </div>
  );
}
