"use client";

import { CreditCard, CheckCircle2, ArrowUpRight, Receipt, Download } from 'lucide-react';

export default function BillingPage() {

  return (
    <div className="max-w-6xl mx-auto space-y-8 animate-in fade-in zoom-in-95 duration-500">
      
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-black text-zinc-900 dark:text-zinc-100 flex items-center gap-3">
            <CreditCard size={28} className="text-indigo-600" />
            Billing & Subscription
          </h1>
          <p className="text-zinc-500 font-medium mt-1">Manage your WalaaPlus SaaS active plan and payment methods.</p>
        </div>
        <button className="bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-2.5 px-6 rounded-xl flex items-center gap-2 shadow-lg shadow-indigo-600/20 transition-all select-none">
          <ArrowUpRight size={18} />
          Upgrade Plan
        </button>
      </div>

      <div className="grid lg:grid-cols-3 gap-6">
        
        {/* Active Plan Card */}
        <div className="lg:col-span-2 bg-gradient-to-br from-indigo-600 to-indigo-800 text-white rounded-3xl p-8 shadow-xl shadow-indigo-600/20 relative overflow-hidden">
          <div className="absolute top-0 right-0 w-64 h-64 bg-white/10 rounded-full blur-3xl -translate-y-1/2 translate-x-1/3 pointer-events-none"></div>
          
          <div className="relative z-10 flex flex-col h-full justify-between">
            <div className="flex justify-between items-start mb-12">
              <div>
                <div className="inline-flex items-center gap-2 bg-white/20 backdrop-blur-md px-3 py-1 rounded-full text-xs font-bold tracking-widest uppercase mb-4 shadow-sm border border-white/20">
                  <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
                  Active Plan
                </div>
                <h2 className="text-4xl font-black tracking-tight mb-2">Growth (Business)</h2>
                <p className="text-indigo-200 font-medium">10 Geofencing Locations, Unlimited Cards</p>
              </div>
              <div className="text-right">
                <span className="text-4xl font-black">450,000</span>
                <span className="text-indigo-200 font-bold ml-2">SYP / mo</span>
              </div>
            </div>

            <div className="grid sm:grid-cols-2 gap-4 border-t border-white/20 pt-6">
              <div>
                <p className="text-indigo-200 text-sm font-bold mb-1">Billing Cycle</p>
                <p className="font-bold flex items-center gap-2">Monthly <CheckCircle2 size={16} className="text-emerald-400" /></p>
              </div>
              <div>
                <p className="text-indigo-200 text-sm font-bold mb-1">Next Payment</p>
                <p className="font-bold">April 24, 2026</p>
              </div>
            </div>
          </div>
        </div>

        {/* Payment Method */}
        <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-3xl p-8 shadow-sm flex flex-col justify-between">
          <div>
            <h3 className="text-lg font-bold mb-6 flex items-center gap-2">
              <CreditCard size={20} className="text-zinc-400" />
              Payment Method
            </h3>
            
            <div className="bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-2xl p-5 mb-4">
              <div className="flex justify-between items-center mb-4">
                <div className="flex gap-2">
                  <div className="w-10 h-6 bg-zinc-200 dark:bg-zinc-800 rounded-md"></div>
                  <span className="font-bold">•••• 4242</span>
                </div>
                <div className="bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600 text-xs font-bold px-2 py-1 rounded border border-emerald-200 dark:border-emerald-800">Primary</div>
              </div>
              <div className="text-sm font-medium text-zinc-500">Expires 12/28</div>
            </div>
          </div>
          
          <button className="w-full text-zinc-700 dark:text-zinc-300 font-bold hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors py-3 rounded-xl border border-zinc-200 dark:border-zinc-800">
            Update Payment Method
          </button>
        </div>
      </div>

      {/* Invoices History */}
      <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-3xl p-8 shadow-sm">
        <div className="flex justify-between items-center mb-6">
          <h3 className="text-lg font-bold flex items-center gap-2">
            <Receipt size={20} className="text-zinc-400" />
            Billing History
          </h3>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-zinc-200 dark:border-zinc-800 text-sm text-zinc-500 uppercase tracking-wider">
                <th className="pb-4 font-bold">Invoice Date</th>
                <th className="pb-4 font-bold">Amount</th>
                <th className="pb-4 font-bold">Status</th>
                <th className="pb-4 font-bold text-right">Receipt</th>
              </tr>
            </thead>
            <tbody className="text-sm font-medium divide-y divide-zinc-200 dark:divide-zinc-800">
              {[
                { date: 'March 24, 2026', amount: '450,000 SYP', status: 'PAID' },
                { date: 'February 24, 2026', amount: '450,000 SYP', status: 'PAID' },
                { date: 'January 24, 2026', amount: '450,000 SYP', status: 'PAID' }
              ].map((invoice, i) => (
                <tr key={i} className="hover:bg-zinc-50 dark:hover:bg-zinc-900/50 transition-colors">
                  <td className="py-4 text-zinc-900 dark:text-zinc-100">{invoice.date}</td>
                  <td className="py-4 text-zinc-600 dark:text-zinc-400">{invoice.amount}</td>
                  <td className="py-4">
                    <span className="bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 px-2 py-1.5 rounded-md text-xs font-bold border border-emerald-200 dark:border-emerald-800/50 flex items-center gap-1 w-max">
                      <CheckCircle2 size={12} /> {invoice.status}
                    </span>
                  </td>
                  <td className="py-4 text-right">
                    <button className="text-indigo-600 hover:text-indigo-700 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-900/30 p-2 rounded-lg hover:bg-indigo-100 dark:hover:bg-indigo-800/50 transition-colors inline-block">
                      <Download size={16} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

    </div>
  );
}
