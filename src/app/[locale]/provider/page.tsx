import { Building2, Users, Activity, Settings2 } from "lucide-react";

export default function ProviderDashboard() {
  const stats = [
    { label: "Total Agencies", value: "12", icon: Building2 },
    { label: "Active Businesses", value: "348", icon: Users },
    { label: "Monthly API Calls", value: "2.4M", icon: Activity },
    { label: "MRR", value: "$4,450", icon: Settings2 }
  ];

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950 p-6 sm:p-10 font-sans" dir="ltr">
      <div className="max-w-7xl mx-auto space-y-8">
        <div>
           <h1 className="text-4xl font-black tracking-tight text-zinc-900 dark:text-zinc-100">WalaaPlus HQ</h1>
           <p className="text-zinc-500 mt-2 text-lg">SaaS Provider Command Center</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
           {stats.map(s => (
              <div key={s.label} className="bg-white dark:bg-zinc-900 p-6 rounded-[2rem] border border-zinc-200 dark:border-zinc-800 shadow-sm flex items-center justify-between hover:scale-[1.02] transition-transform">
                <div>
                   <div className="text-zinc-500 text-sm font-semibold tracking-wide uppercase">{s.label}</div>
                   <div className="text-3xl font-black mt-2 text-zinc-900 dark:text-zinc-100">{s.value}</div>
                </div>
                <div className="w-14 h-14 rounded-2xl bg-indigo-50 dark:bg-indigo-500/10 flex items-center justify-center text-indigo-600 dark:text-indigo-400">
                   <s.icon className="w-7 h-7" />
                </div>
              </div>
           ))}
        </div>

        <div className="bg-white dark:bg-zinc-900 rounded-[2rem] border border-zinc-200 dark:border-zinc-800 overflow-hidden shadow-xl">
           <div className="p-8 border-b border-zinc-200 dark:border-zinc-800 flex justify-between items-center bg-zinc-50/50 dark:bg-zinc-900/50">
              <h2 className="text-xl font-bold text-zinc-900 dark:text-zinc-100 flex items-center gap-3">
                 <Building2 className="w-6 h-6 text-indigo-500" />
                 Agency Sub-Tenants
              </h2>
              <button className="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white font-bold rounded-xl shadow-md transition-colors text-sm">
                + Provision New Agency
              </button>
           </div>
           
           <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                 <thead className="bg-zinc-50 dark:bg-zinc-950/50 text-zinc-500 font-semibold tracking-wide uppercase text-xs border-b border-zinc-200 dark:border-zinc-800">
                   <tr>
                      <th className="px-8 py-5">Agency / White-label Domain</th>
                      <th className="px-8 py-5">Businesses</th>
                      <th className="px-8 py-5">Platform Tier</th>
                      <th className="px-8 py-5">Status</th>
                   </tr>
                 </thead>
                 <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
                   <tr className="hover:bg-zinc-50 dark:hover:bg-zinc-800/20 transition-colors">
                      <td className="px-8 py-6 font-bold text-zinc-900 dark:text-zinc-100 flex items-center gap-3">
                         <div className="w-10 h-10 rounded-full bg-blue-100 dark:bg-blue-900/30 text-blue-600 flex items-center justify-center font-bold">M</div>
                         <div>
                            Marketing Syria
                            <div className="text-xs text-zinc-500 font-medium">marketing-sy.com</div>
                         </div>
                      </td>
                      <td className="px-8 py-6 text-zinc-600 dark:text-zinc-400 font-medium">45 Active</td>
                      <td className="px-8 py-6 text-zinc-600 dark:text-zinc-400 font-medium">Enterprise</td>
                      <td className="px-8 py-6">
                         <span className="text-emerald-600 dark:text-emerald-400 bg-emerald-100 dark:bg-emerald-500/10 px-3 py-1.5 rounded-full font-bold text-xs tracking-wide">
                            ONLINE
                         </span>
                      </td>
                   </tr>
                   <tr className="hover:bg-zinc-50 dark:hover:bg-zinc-800/20 transition-colors">
                      <td className="px-8 py-6 font-bold text-zinc-900 dark:text-zinc-100 flex items-center gap-3">
                         <div className="w-10 h-10 rounded-full bg-purple-100 dark:bg-purple-900/30 text-purple-600 flex items-center justify-center font-bold">D</div>
                         <div>
                            Damascus Media
                            <div className="text-xs text-zinc-500 font-medium">damascusmedia.net</div>
                         </div>
                      </td>
                      <td className="px-8 py-6 text-zinc-600 dark:text-zinc-400 font-medium">120 Active</td>
                      <td className="px-8 py-6 text-zinc-600 dark:text-zinc-400 font-medium">Ultimate (Unlimited)</td>
                      <td className="px-8 py-6">
                         <span className="text-emerald-600 dark:text-emerald-400 bg-emerald-100 dark:bg-emerald-500/10 px-3 py-1.5 rounded-full font-bold text-xs tracking-wide">
                            ONLINE
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
