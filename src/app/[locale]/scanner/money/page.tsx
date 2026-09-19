import { redirect } from "next/navigation";

/**
 * Money cards are reached by scanning or looking up the customer on `/scanner`. The counter is
 * rendered in that authenticated page's in-memory result, so a customerCardId is never accepted,
 * exposed or retained in a browser URL or history entry.
 */
export default async function MoneyCounterPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  redirect(`/${locale}/scanner`);
}
