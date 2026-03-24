import { getTranslations } from "next-intl/server";
import { Users, CreditCard, Activity, ArrowUpRight } from "lucide-react";

export default async function BusinessDashboardOverview() {
  const t = await getTranslations("DashboardOverview");

  const stats = [
    {
      title: t("totalCustomers"),
      value: "2,543",
      trend: "+12%",
      icon: Users,
      color: "text-blue-600 dark:text-blue-400",
      bg: "bg-blue-50 dark:bg-blue-500/10"
    },
    {
      title: t("activeCards"),
      value: "1,205",
      trend: "+5%",
      icon: CreditCard,
      color: "text-indigo-600 dark:text-indigo-400",
      bg: "bg-indigo-50 dark:bg-indigo-500/10"
    },
    {
      title: t("pointsIssued"),
      value: "45,230",
      trend: "+24%",
      icon: Activity,
      color: "text-emerald-600 dark:text-emerald-400",
      bg: "bg-emerald-50 dark:bg-emerald-500/10"
    }
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-zinc-900 dark:text-zinc-100">
            {t("title")}
          </h1>
          <p className="text-zinc-500 dark:text-zinc-400 mt-1">
            {t("subtitle")}
          </p>
        </div>
        <button className="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl font-medium shadow-sm transition-all focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 dark:focus:ring-offset-zinc-950 flex items-center gap-2">
          {t("newCardAction")}
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
        {stats.map((stat, i) => {
          const Icon = stat.icon;
          return (
            <div key={i} className="bg-white dark:bg-zinc-900 rounded-2xl p-6 border border-zinc-200 dark:border-zinc-800 shadow-sm hover:shadow-md transition-shadow">
              <div className="flex justify-between items-start">
                <div className="space-y-2">
                  <p className="text-sm font-medium text-zinc-500 dark:text-zinc-400">
                    {stat.title}
                  </p>
                  <p className="text-3xl font-bold text-zinc-900 dark:text-zinc-100">
                    {stat.value}
                  </p>
                </div>
                <div className={`p-3 rounded-xl ${stat.bg}`}>
                  <Icon className={`w-6 h-6 ${stat.color}`} />
                </div>
              </div>
              <div className="mt-4 flex items-center gap-1 text-sm">
                <span className="text-emerald-600 flex items-center font-medium">
                  <ArrowUpRight className="w-4 h-4 mr-1" />
                  {stat.trend}
                </span>
                <span className="text-zinc-500 dark:text-zinc-400 ms-2">
                  {t("vsLastMonth")}
                </span>
              </div>
            </div>
          );
        })}
      </div>
      
      {/* Chart Placeholder for Premium Feel */}
      <div className="bg-white dark:bg-zinc-900 rounded-2xl p-6 border border-zinc-200 dark:border-zinc-800 shadow-sm mt-8 min-h-[400px]">
         <h2 className="text-lg font-bold mb-6 text-zinc-900 dark:text-zinc-100">{t("growthChart")}</h2>
         <div className="w-full h-[300px] flex items-center justify-center bg-zinc-50 dark:bg-zinc-800/50 rounded-xl border border-dashed border-zinc-200 dark:border-zinc-700">
            <span className="text-zinc-500 font-medium">Interactive Recharts area loading...</span>
         </div>
      </div>
    </div>
  );
}
