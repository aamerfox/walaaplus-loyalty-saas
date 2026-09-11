"use client";

import { useLocale } from "next-intl";
import { Users, UserPlus, Fingerprint, MapPin, MoreVertical } from "lucide-react";

export default function TeamManagementPage() {
  const locale = useLocale();
  const dir = locale === 'ar' ? 'rtl' : 'ltr';

  const team = [
    {
      id: "usr_1",
      name: locale === 'ar' ? 'أحمد سامر' : 'Ahmed Samer',
      role: 'MANAGER',
      location: locale === 'ar' ? 'جميع الفروع' : 'All Locations',
      status: 'ACTIVE',
      lastLogin: '2 ساعات مضت',
    },
    {
      id: "usr_2",
      name: locale === 'ar' ? 'محمود علي (كاشير)' : 'Mahmoud Ali (Cashier)',
      role: 'CASHIER',
      location: locale === 'ar' ? 'فرع دمشق (المزة)' : 'Damascus Branch',
      status: 'ACTIVE',
      lastLogin: 'اليوم',
    },
    {
      id: "usr_3",
      name: locale === 'ar' ? 'سارة محمد' : 'Sarah Moh',
      role: 'CASHIER',
      location: locale === 'ar' ? 'فرع حلب' : 'Aleppo Branch',
      status: 'OFFLINE',
      lastLogin: 'منذ يومين',
    }
  ];

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950 p-6 sm:p-10 font-sans" dir={dir}>
      <div className="max-w-7xl mx-auto space-y-8">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
           <div>
              <h1 className="text-4xl font-black tracking-tight text-zinc-900 dark:text-zinc-100">
                {locale === 'ar' ? 'إدارة فريق العمل (Managers & Cashiers)' : 'Team Management'}
              </h1>
              <p className="text-zinc-500 mt-2 text-lg">
                {locale === 'ar' ? 'أضف الكاشير والمدراء لمنحهم حق الوصول إلى تطبيق الماسح الضوئي لمعالجة الأختام.' : 'Add Cashiers and Managers to grant them access to the Scanner App for processing stamps.'}
              </p>
           </div>
           <button className="bg-indigo-600 hover:bg-indigo-700 text-white px-6 py-3 rounded-2xl font-bold flex items-center gap-2 transition-all shadow-lg active:scale-95">
              <UserPlus className="w-5 h-5" />
              {locale === 'ar' ? 'إضافة موظف جديد' : 'Invite Team Member'}
           </button>
        </div>

        <div className="bg-white dark:bg-zinc-900 rounded-[2.5rem] border border-zinc-200 dark:border-zinc-800 shadow-xl overflow-hidden">
           <div className="p-8 border-b border-zinc-200 dark:border-zinc-800 flex items-center justify-between bg-zinc-50/50 dark:bg-zinc-900/50">
              <div className="flex items-center gap-4">
                 <div className="w-12 h-12 bg-indigo-50 dark:bg-indigo-500/10 text-indigo-600 rounded-xl flex items-center justify-center shadow-inner">
                    <Users className="w-6 h-6" />
                 </div>
                 <div>
                    <h2 className="text-xl font-bold text-zinc-900 dark:text-zinc-100">{locale === 'ar' ? 'صلاحيات الوصول للماسح (Scanner Access)' : 'Scanner Access Accounts'}</h2>
                    <p className="text-sm text-zinc-500 mt-1">{locale === 'ar' ? 'لديك 3 موظفين نشطين' : 'You have 3 active team members'}</p>
                 </div>
              </div>
           </div>

           <div className="overflow-x-auto">
              <table className="w-full text-start text-sm">
                 <thead className="bg-zinc-50 dark:bg-zinc-950/50 text-zinc-500 font-medium border-b border-zinc-200 dark:border-zinc-800">
                   <tr>
                      <th className="px-8 py-5 text-start">{locale === 'ar' ? 'اسم الموظف' : 'Employee Name'}</th>
                      <th className="px-8 py-5 text-start">{locale === 'ar' ? 'الدور (Role)' : 'Role'}</th>
                      <th className="px-8 py-5 text-start">{locale === 'ar' ? 'الفرع المستهدف' : 'Location'}</th>
                      <th className="px-8 py-5 text-start">{locale === 'ar' ? 'حالة الدخول' : 'Status'}</th>
                      <th className="px-8 py-5 text-end"></th>
                   </tr>
                 </thead>
                 <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
                   {team.map((user) => (
                     <tr key={user.id} className="hover:bg-zinc-50 dark:hover:bg-zinc-800/20 transition-colors">
                        <td className="px-8 py-5">
                          <div className="font-bold text-zinc-900 dark:text-zinc-100">{user.name}</div>
                          <div className="text-xs text-zinc-400 mt-1 flex items-center gap-1">
                             <Fingerprint className="w-3 h-3" />
                             {user.id}
                          </div>
                        </td>
                        <td className="px-8 py-5">
                          <span className={`px-3 py-1.5 rounded-full font-bold text-xs tracking-wide ${
                             user.role === 'MANAGER' 
                               ? 'bg-purple-100 text-purple-700 dark:bg-purple-500/10 dark:text-purple-400' 
                               : 'bg-blue-100 text-blue-700 dark:bg-blue-500/10 dark:text-blue-400'
                          }`}>
                            {user.role}
                          </span>
                        </td>
                        <td className="px-8 py-5 text-zinc-600 dark:text-zinc-400 font-medium flex items-center gap-2 mt-2">
                           <MapPin className="w-4 h-4 text-zinc-400" />
                           {user.location}
                        </td>
                        <td className="px-8 py-5">
                          <span className={`px-2 py-1 rounded-md text-xs font-bold flex items-center gap-2 w-max ${
                             user.status === 'ACTIVE'
                               ? 'text-emerald-600'
                               : 'text-zinc-400'
                          }`}>
                             <div className={`w-2 h-2 rounded-full ${user.status === 'ACTIVE' ? 'bg-emerald-500' : 'bg-zinc-400'}`}></div>
                             {user.lastLogin}
                          </span>
                        </td>
                        <td className="px-8 py-5 text-end">
                           <button className="text-zinc-400 hover:text-indigo-600 transition-colors p-2 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800">
                              <MoreVertical className="w-5 h-5" />
                           </button>
                        </td>
                     </tr>
                   ))}
                 </tbody>
              </table>
           </div>
        </div>
      </div>
    </div>
  );
}
