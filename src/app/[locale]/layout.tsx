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
