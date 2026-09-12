import { redirect } from "next/navigation";
import Sidebar from "@/components/dashboard/Sidebar";
import Header from "@/components/dashboard/Header";
import { getCurrentUserId } from "@/server/auth/session";
import { listUserBusinesses } from "@/server/tenant/memberships";

/**
 * The merchant shell: one navy rail, one quiet top bar, one content column.
 *
 * The rail is the product's brand surface and the only place the logo appears; the top bar carries
 * context and language, never a title. Every page below renders its own `PageHeader`, so a screen
 * has exactly one heading — the previous shell printed the tenant name in the bar AND under every
 * page title, which is how a merchant ends up reading their own shop's name as the platform's.
 *
 * The memberships are resolved here, once, from the database. A user with none never reaches a
 * merchant screen: there is nothing for them to act on, and a shell around an empty page is a worse
 * answer than the sign-in they actually need.
 */
export default async function BusinessLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const userId = await getCurrentUserId();
  if (!userId) redirect(`/${locale}/auth/login`);

  const memberships = await listUserBusinesses(userId);
  const businesses = memberships.map((m) => ({ id: m.business.id, name: m.business.name }));

  return (
    <div className="flex h-screen overflow-hidden bg-app">
      <div className="hidden lg:block">
        <Sidebar />
      </div>

      <div className="flex flex-1 flex-col overflow-hidden">
        <Header businesses={businesses} />
        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-6xl space-y-8 px-4 py-6 sm:px-6 sm:py-8 lg:px-10">{children}</div>
        </main>
      </div>
    </div>
  );
}
