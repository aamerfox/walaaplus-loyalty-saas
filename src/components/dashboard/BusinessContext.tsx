"use client";

import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useRouter, usePathname } from "@/i18n/routing";

/**
 * Which business you are acting for — labelled as such, and nothing more.
 *
 * ## Why this component exists
 *
 * The shell used to print the business name in the header at heading size, directly beside the
 * logo. On the staging tenant that read as "TrueBiznes", in the position a product name occupies,
 * on every screen — so the platform appeared to be called TrueBiznes. The owner rejected the
 * release for it, and rightly: a tenant's name is data, and data must never be dressed as identity.
 *
 * So the rule this component encodes is: **the business name appears once, small, under an explicit
 * label, and never as a heading.** The product's name is the logo next to it; this is the account
 * the logo is currently pointed at.
 *
 * ## And it is a real control
 *
 * With one membership it is a labelled value. With several it is a `<select>` that actually
 * switches: every merchant page resolves its tenant from `?b=`, so choosing here changes which
 * business the next render is scoped to — verified on the server, as always. A decorative dropdown
 * would be the same mistake in a different costume.
 */
export default function BusinessContext({
  businesses,
}: {
  businesses: { id: string; name: string }[];
}) {
  const t = useTranslations("Navigation");
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  if (businesses.length === 0) return null;

  const requested = params.get("b");
  const current = businesses.find((b) => b.id === requested) ?? businesses[0];

  if (businesses.length === 1) {
    return (
      <div className="min-w-0 text-end">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">{t("businessLabel")}</p>
        <p className="truncate text-sm font-semibold text-ink" data-testid="current-business">
          {current.name}
        </p>
      </div>
    );
  }

  return (
    <div className="min-w-0">
      <label htmlFor="business-context" className="block text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
        {t("businessLabel")}
      </label>
      <select
        id="business-context"
        data-testid="current-business"
        value={current.id}
        onChange={(event) => router.replace(`${pathname}?b=${event.target.value}`)}
        className="mt-0.5 max-w-[11rem] truncate rounded-lg border border-border bg-surface px-2 py-1 text-sm font-semibold text-ink outline-none focus:border-turquoise-500"
      >
        {businesses.map((business) => (
          <option key={business.id} value={business.id}>
            {business.name}
          </option>
        ))}
      </select>
    </div>
  );
}
