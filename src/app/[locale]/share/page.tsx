import type { Metadata, Viewport } from "next";
import { Wordmark } from "@/components/brand/Wordmark";
import ShareInvite from "./ShareInvite";

/**
 * The public invitation page. One address for every business, one capability per card.
 *
 * ## Why it is the same page for everyone
 *
 * The URL is `https://host/share#<token>` — one path, and the capability in the fragment. Nothing
 * about which card, which business or which customer appears in the path, so the address in a
 * browser history, a shared screenshot or a chat preview says only "somebody opened Zademi's
 * invitation page". What it opens is decided in the browser.
 *
 * ## What this server component may know: nothing
 *
 * A fragment is not sent with a request, so this page is rendered with no knowledge of which link
 * was opened — which is exactly the property that keeps the token out of every log. All of the
 * behaviour is in `ShareInvite`, in the browser.
 *
 * ## Not a route into the product
 *
 * Opening this page joins nobody to anything. There is no form, no phone field, no card lookup and
 * no enrolment: public self-service enrolment was withdrawn by owner decision **B7 option 3**, and
 * a page reachable by a link that anyone can forward is the last place to reintroduce one. It also
 * awards nothing — no referral credit, no stamp, no reward — because no referral policy exists
 * (D15). It shares a link.
 */

export const metadata: Metadata = {
  title: "Zademi",
  // An invitation link is a capability, and a capability is not content to index.
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: "#0B2D5B",
};

export default function SharePage() {
  return (
    <main className="min-h-screen bg-zinc-950 px-4 py-10 text-zinc-100">
      <div className="mx-auto w-full max-w-sm space-y-8">
        {/*
         * The Zademi mark, on the one public page a stranger reaches without ever having heard of
         * the product. The approved white-on-dark treatment, served from `public/brand/` exactly as
         * supplied — nothing here recolours or rasterises it.
         */}
        <div className="flex justify-center">
          <Wordmark tone="white" height={28} />
        </div>

        <ShareInvite />

        {/*
         * Who is showing this page, said once and quietly. A visitor deciding whether to trust a
         * forwarded link deserves to know whose product it is.
         */}
        <p className="text-center text-xs text-zinc-500">Zademi</p>
      </div>
    </main>
  );
}
