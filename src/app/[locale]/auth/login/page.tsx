"use client";

import { useLocale, useTranslations } from "next-intl";
import { Link } from "@/i18n/routing";
import { Lock, Eye, EyeOff } from "lucide-react";
import { useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";

export default function LoginPage() {
  const locale = useLocale();
  const dir = locale === 'ar' ? 'rtl' : 'ltr';
  const [showPassword, setShowPassword] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  const tc = useTranslations('Common');
  const searchParams = useSearchParams();

  /**
   * Where to go after signing in.
   *
   * Only a path within this site is accepted — a `callbackUrl` of `https://elsewhere/` would turn
   * the login form into an open redirect, which is worth more to a phisher than the form itself.
   * The scanner's public login uses this to land a cashier on the scanner rather than the
   * merchant dashboard.
   */
  const destination = (() => {
    const requested = searchParams.get('callbackUrl');
    if (requested && requested.startsWith('/') && !requested.startsWith('//')) return requested;
    return `/${locale}/business`;
  })();

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    const res = await signIn("credentials", {
      redirect: false,
      email,
      password,
    });

    if (res?.error) {
      setError(tc('invalidCredentials'));
      setLoading(false);
    } else {
      router.push(destination);
      router.refresh();
    }
  };

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950 flex flex-col justify-center font-sans relative overflow-hidden" dir={dir}>
      
      {/* Background Ambience */}
      <div className="absolute inset-0 pointer-events-none -z-10">
         <div className={`absolute top-0 ${locale === 'ar' ? 'right-0' : 'left-0'} w-1/2 h-full bg-indigo-50 dark:bg-indigo-950/20 blur-3xl opacity-50`}></div>
      </div>

      <div className="w-full max-w-md mx-auto p-6">
        
        {/* Logo */}
        <div className="flex justify-center mb-8">
           <Link href="/" className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-2xl bg-indigo-600 flex items-center justify-center shadow-lg shadow-indigo-600/30">
                 <span className="text-white font-black text-2xl">W</span>
              </div>
           </Link>
        </div>

        <div className="bg-white dark:bg-zinc-900 rounded-[2rem] p-8 shadow-xl border border-zinc-200 dark:border-zinc-800">
           
           <div className="text-center mb-8">
              <h1 className="text-2xl font-black text-zinc-900 dark:text-zinc-100 mb-2">
                 {locale === 'ar' ? 'تسجيل الدخول' : 'Welcome Back'}
              </h1>
              <p className="text-zinc-500 font-medium text-sm">
                 {locale === 'ar' ? 'أدخل تفاصيل حسابك للوصول للوحة القيادة' : 'Enter your credentials to access your dashboard'}
              </p>
           </div>

           <form className="space-y-5" onSubmit={handleLogin}>
              {error && (
                <div className="bg-red-50 text-red-600 p-3 rounded-lg text-sm text-center font-bold">
                  {error}
                </div>
              )}
              
              <div className="space-y-2">
                 <label className="text-xs font-bold uppercase tracking-wider text-zinc-500">
                    {locale === 'ar' ? 'البريد الإلكتروني' : 'Email Address'}
                 </label>
                 <input 
                    type="email" 
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    placeholder="name@company.com" 
                    className="w-full bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-indigo-500 outline-none transition-all dark:text-white"
                 />
              </div>

              <div className="space-y-2">
                 <div className="flex justify-between items-center">
                    <label className="text-xs font-bold uppercase tracking-wider text-zinc-500">
                       {locale === 'ar' ? 'كلمة المرور' : 'Password'}
                    </label>
                    <a href="#" className="text-xs font-bold text-indigo-600 hover:text-indigo-700">
                       {locale === 'ar' ? 'نسيت كلمة المرور؟' : 'Forgot password?'}
                    </a>
                 </div>
                 <div className="relative">
                    <input 
                       type={showPassword ? 'text' : 'password'} 
                       value={password}
                       onChange={(e) => setPassword(e.target.value)}
                       required
                       placeholder="••••••••" 
                       className="w-full bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-indigo-500 outline-none transition-all dark:text-white"
                    />
                    <button 
                       type="button" 
                       onClick={() => setShowPassword(!showPassword)}
                       className={`absolute inset-y-0 ${locale === 'ar' ? 'left-3' : 'right-3'} flex items-center text-zinc-400 hover:text-zinc-600`}
                    >
                       {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                    </button>
                 </div>
              </div>

              <div className="pt-2">
                 <button 
                    type="submit" 
                    disabled={loading}
                    className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white font-bold py-3.5 rounded-xl flex justify-center items-center gap-2 shadow-lg shadow-indigo-600/20 transition-transform active:scale-95">
                    <Lock size={18} />
                    {loading ? (locale === 'ar' ? 'جاري التحقق...' : 'Signing in...') : (locale === 'ar' ? 'تسجيل الدخول' : 'Sign In')}
                 </button>
              </div>

           </form>

           <div className="mt-8 text-center">
              <p className="text-sm font-medium text-zinc-500">
                 {locale === 'ar' ? 'ليس لديك حساب؟' : "Don't have an account?"}{' '}
                 <Link href="/auth/register" className="text-indigo-600 font-bold hover:underline">
                    {locale === 'ar' ? 'سجل الآن مجاناً' : 'Start your free trial'}
                 </Link>
              </p>
           </div>

        </div>

        {/* Footer */}
        <div className="text-center mt-8">
           <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-zinc-200/50 dark:bg-zinc-800/50 text-xs font-bold text-zinc-500">
              <Lock size={12} />
              {locale === 'ar' ? 'اتصال مشفر ومحمي 256-bit' : 'Secure 256-bit SSL Connection'}
           </div>
        </div>

      </div>
    </div>
  );
}
