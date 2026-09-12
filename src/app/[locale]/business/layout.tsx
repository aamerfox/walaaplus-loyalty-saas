import { redirect } from "next/navigation";
import Sidebar from "@/components/dashboard/Sidebar";
import Header from "@/components/dashboard/Header";
import { getCurrentUserId } from "@/server/auth/session";
import { getStaffInitials, listUserBusinesses } from "@/server/tenant/memberships";

/**
 * The merchant shell.
 *
 * It resolves the acting business here, once, from the database — so every screen below it renders
 * under a membership that was checked on this request, and the header shows a name that came from
 * that check rather than from a session token.
 *
 * A user with no membership never reaches a merchant screen: there is nothing for them to act on,
 * and a shell around an empty page is a worse answer than the sign-in they actually need.
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
  const businessName = memberships[0]?.business.name ?? "";

  const initials = await getStaffInitials(userId);

  return (
    <div className="flex h-screen overflow-hidden bg-app">
      <div className="hidden lg:block">
        <Sidebar />
      </div>

      <div className="flex flex-1 flex-col overflow-hidden">
        <Header businessName={businessName} userInitials={initials} />
        <main className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8">
          <div className="mx-auto max-w-6xl space-y-6">{children}</div>
        </main>
      </div>
    </div>
  );
}
