import { getTranslations } from "next-intl/server";
import { Search, Filter, MoreHorizontal, Download } from "lucide-react";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { cn } from "@/lib/utils";

export default async function CustomersCRM({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const isAr = locale === 'ar';
  const t = await getTranslations("CRM");
  
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) return <div className="p-8 text-center font-bold text-rose-600">Unauthorized</div>;

  const user = await prisma.user.findUnique({
    where: { email: session.user.email },
    include: { ownedBusiness: true }
  });

  let businessId = user?.ownedBusiness?.id;
  if (!businessId && user) {
    const biz = await prisma.business.findFirst({ where: { ownerId: user.id } });
    businessId = biz?.id;
  }

  const customers = businessId ? await prisma.user.findMany({
    where: {
      role: 'CUSTOMER',
      customerCards: {
        some: {
          template: {
            businessId
          }
        }
      }
    },
    include: {
      customerCards: {
        where: { template: { businessId } },
        include: { transactions: { orderBy: { createdAt: 'desc' }, take: 1 } }
      }
    },
    orderBy: { createdAt: 'desc' }
  }) : [];

  const formattedCustomers = customers.map(c => {
    const card = c.customerCards[0];
    const lastVisit = card?.lastVisitAt ? new Date(card.lastVisitAt).toLocaleDateString(locale) : (isAr ? 'لا يوجد' : 'None');
    return {
      id: c.id,
      name: c.name || (isAr ? 'عميل بدون اسم' : 'Unnamed Customer'),
      phone: c.phone || 'N/A',
      visits: card?.transactions.length || 0,
      lastVisit,
      points: card?.currentBalance || 0,
      status: card?.status === 'ACTIVE' ? (isAr ? 'نشط' : 'Active') : (isAr ? 'غير نشط' : 'Inactive')
    };
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-zinc-900 dark:text-zinc-100">{t("title")}</h1>
          <p className="text-zinc-500 mt-1">{t("subtitle")}</p>
        </div>
        <div className="flex gap-3">
           <button className="px-4 py-2.5 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-800/50 rounded-xl shadow-sm text-sm font-medium flex items-center gap-2 transition-all">
             <Download className="w-4 h-4" />
             {t("export")}
           </button>
           <button className="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl shadow-sm text-sm font-medium transition-all">
             {t("addCustomer")}
           </button>
        </div>
      </div>

      <div className="bg-white dark:bg-zinc-900 rounded-2xl border border-zinc-200 dark:border-zinc-800 shadow-sm overflow-hidden">
         <div className="p-4 border-b border-zinc-200 dark:border-zinc-800 flex flex-col sm:flex-row gap-4 justify-between bg-zinc-50/50 dark:bg-zinc-900/50">
            <div className="relative max-w-sm w-full">
               <Search className="w-5 h-5 absolute start-3 top-2.5 text-zinc-400" />
               <input type="text" placeholder={t("searchPlaceholder")} className="w-full bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl ps-10 pe-4 py-2.5 text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none transition-all dark:text-zinc-100 placeholder-zinc-500" />
            </div>
            <button className="px-4 py-2.5 bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl shadow-sm text-sm font-medium flex items-center gap-2 hover:bg-zinc-50 transition-all">
               <Filter className="w-4 h-4" />
               {t("filter")}
            </button>
         </div>
         
         <div className="overflow-x-auto">
            <table className="w-full text-start text-sm text-zinc-900 dark:text-zinc-100">
               <thead className="bg-zinc-50 dark:bg-zinc-900/80 text-zinc-500 dark:text-zinc-400 border-b border-zinc-200 dark:border-zinc-800">
                  <tr>
                     <th className="px-6 py-4 font-semibold text-start">{t("name")}</th>
                     <th className="px-6 py-4 font-semibold text-start">{t("phone")}</th>
                     <th className="px-6 py-4 font-semibold text-start">{t("visits")}</th>
                     <th className="px-6 py-4 font-semibold text-start">{t("lastVisit")}</th>
                     <th className="px-6 py-4 font-semibold text-start">{t("points")}</th>
                     <th className="px-6 py-4 font-semibold text-start">{t("status")}</th>
                     <th className="px-6 py-4 font-semibold text-end"></th>
                  </tr>
               </thead>
               <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
                  {formattedCustomers.length > 0 ? formattedCustomers.map(c => (
                     <tr key={c.id} className="hover:bg-zinc-50/80 dark:hover:bg-zinc-800/30 transition-colors">
                        <td className="px-6 py-4 font-medium">{c.name}</td>
                        <td className="px-6 py-4 text-zinc-500 dark:text-zinc-400">{c.phone}</td>
                        <td className="px-6 py-4 font-medium">{c.visits}</td>
                        <td className="px-6 py-4 text-zinc-500 dark:text-zinc-400">{c.lastVisit}</td>
                        <td className="px-6 py-4 font-bold text-indigo-600 dark:text-indigo-400">{c.points}</td>
                        <td className="px-6 py-4">
                           <span className={cn(
                             "px-3 py-1 text-xs font-bold tracking-wide rounded-full",
                             c.status === 'Active' || c.status === 'نشط' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400' : 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400'
                           )}>
                              {c.status}
                           </span>
                        </td>
                        <td className="px-6 py-4 text-end text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300">
                           <button className="p-2 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-lg transition-colors"><MoreHorizontal className="w-5 h-5 mx-auto" /></button>
                        </td>
                     </tr>
                  )) : (
                    <tr>
                      <td colSpan={7} className="px-6 py-10 text-center text-zinc-500 font-medium italic">
                        {isAr ? 'لا يوجد عملاء مسجلين بعد' : 'No customers registered yet'}
                      </td>
                    </tr>
                  )}
               </tbody>
            </table>
         </div>
      </div>
    </div>
  );
}
