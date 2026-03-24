import { getTranslations } from "next-intl/server";

export default async function SettingsPage() {
  const t = await getTranslations("Navigation");

  return (
    <div className="p-8">
      <h1 className="text-3xl font-bold text-zinc-900 dark:text-zinc-100 mb-6">{t("settings")}</h1>
      
      <div className="bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-3xl p-8 max-w-2xl shadow-sm">
         <h2 className="text-xl font-bold text-zinc-900 dark:text-white mb-6">Business Profile</h2>
         <div className="space-y-6">
            <div>
               <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-400 mb-2">Business Name</label>
               <input type="text" defaultValue="Damascus Cafe Hub" className="w-full bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl px-4 py-3.5 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-all text-zinc-900 dark:text- सफेद shadow-inner" />
            </div>
            <div>
               <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-400 mb-2">Contact Email</label>
               <input type="email" defaultValue="hello@damascushub.sy" className="w-full bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl px-4 py-3.5 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-all text-zinc-900 dark:text-white shadow-inner" />
            </div>
            
            <hr className="border-zinc-200 dark:border-zinc-800 my-8" />
            
            <button className="px-8 py-3.5 bg-indigo-600 hover:bg-indigo-700 text-white font-bold rounded-xl transition-all shadow-lg active:scale-95">
               Save Configuration
            </button>
         </div>
      </div>
    </div>
  );
}
