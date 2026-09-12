import { NextResponse } from "next/server";
import { getCardManifestView } from "@/server/customers/card-view";
import { isAppError } from "@/server/errors";

/**
 * The web manifest for ONE card.
 *
 * Generated per card, not shared, because a customer with cards from three cafés needs three
 * installable apps with three names and three icons (PRODUCT-SPEC §6.2). `id` and `start_url` are
 * this card's own path, which is what makes the browser treat them as separate applications
 * rather than three attempts to install the same one.
 *
 * It carries only the business and program name. No balance, no customer name, no identifier: a
 * manifest is cached aggressively by browsers and may outlive the data in it, so anything that
 * changes — or that would be sensitive on a stale copy — does not belong here.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ locale: string; shareToken: string }> }) {
  const { locale, shareToken } = await params;

  try {
    const view = await getCardManifestView(shareToken);
    const start = `/${locale}/card/${shareToken}`;

    return NextResponse.json(
      {
        id: start,
        name: `${view.businessName} — ${view.programName}`,
        short_name: view.businessName.slice(0, 12),
        description: view.programName,
        start_url: start,
        scope: start,
        display: "standalone",
        orientation: "portrait",
        // Zademi navy. This is the tint an installed card paints its status bar and task-switcher
        // entry with, so it is brand surface rather than decoration - and it must match the
        // `themeColor` the card page declares, or the two disagree on a real phone.
        background_color: "#071D3B",
        theme_color: "#0B2D5B",
        dir: locale === "ar" ? "rtl" : "ltr",
        lang: locale,
        icons: [
          { src: "/icons/card-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "/icons/card-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "/icons/card-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      {
        headers: {
          "content-type": "application/manifest+json; charset=utf-8",
          // Short cache: the business name can change, and a manifest pinned for a day would keep
          // the old one on the home screen. Private: this URL is tied to one customer's card.
          "cache-control": "private, max-age=300",
        },
      },
    );
  } catch (e) {
    if (isAppError(e)) return new NextResponse(null, { status: 404 });
    throw e;
  }
}
