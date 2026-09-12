import type { Metadata } from "next";
import { getMessages, getTranslations } from "next-intl/server";
import { NextIntlClientProvider } from "next-intl";
import { Cairo, Inter, Nunito } from "next/font/google";
import { AuthProvider } from "@/components/providers/AuthProvider";
import "./globals.css";

/**
 * Fonts are downloaded at BUILD time by `next/font` and served from this origin.
 *
 * That is the whole reason this is not a `<link>` to fonts.googleapis.com: a stylesheet link would
 * make every page load of a merchant's till send a request to a third party, with the referrer and
 * the IP address of a shop in Damascus attached. `next/font/google` fetches the files during the
 * build, rewrites the CSS to point at `/_next/static`, and nothing leaves the browser afterwards.
 *
 * Three faces, each with a job: Nunito for headings (the rounded, friendly half of the brand),
 * Inter for Latin body copy, and Cairo for Arabic — which needs a real Arabic face, not a fallback.
 */
const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const nunito = Nunito({ subsets: ["latin"], variable: "--font-nunito", display: "swap" });
const cairo = Cairo({ subsets: ["arabic", "latin"], variable: "--font-cairo", display: "swap" });

/**
 * The browser-tab title.
 *
 * A template rather than a constant, so every page reads "<page> · Zademi" without each one having
 * to remember the product name, and the bare title is used only where a page sets none.
 */
export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "Brand" });
  return {
    title: { default: t("productName"), template: `%s · ${t("productName")}` },
    description: t("tagline"),
    applicationName: t("productName"),
    /*
     * Icons, all rendered from the approved master by `scripts/make-icons.mjs`.
     *
     * `/favicon.ico` is listed explicitly as well as the PNGs: a browser that finds no `<link>` —
     * a bare fetch of that path, a feed reader, a crawler — asks for it by name regardless.
     */
    icons: {
      icon: [
        { url: "/icons/favicon-32.png", sizes: "32x32", type: "image/png" },
        { url: "/icons/favicon-16.png", sizes: "16x16", type: "image/png" },
        { url: "/favicon.ico", sizes: "any" },
      ],
      apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
    },
    /*
     * A link to a Zademi page shows the product, not a blank card. There is nothing tenant-specific
     * here on purpose: the pages worth sharing are marketing, and the pages that are not shareable
     * are capabilities that must never render a preview of a customer's card.
     */
    openGraph: {
      title: t("productName"),
      description: t("tagline"),
      siteName: t("productName"),
      locale: locale === "ar" ? "ar_SY" : "en_US",
      type: "website",
      images: [{ url: "/icons/card-512.png", width: 512, height: 512, alt: t("productName") }],
    },
    twitter: { card: "summary", title: t("productName"), description: t("tagline"), images: ["/icons/card-512.png"] },
    // A loyalty product is not content to index, and several of its pages are capabilities.
    robots: { index: false, follow: false },
  };
}

export default async function RootLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const messages = await getMessages();

  return (
    <html
      lang={locale}
      dir={locale === "ar" ? "rtl" : "ltr"}
      className={`${inter.variable} ${nunito.variable} ${cairo.variable}`}
      suppressHydrationWarning
    >
      <body suppressHydrationWarning>
        <NextIntlClientProvider messages={messages}>
          <AuthProvider>{children}</AuthProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
