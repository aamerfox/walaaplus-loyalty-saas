"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { Button, Field, Notice, TextInput } from "@/components/ui";

/**
 * The counter-management controls.
 *
 * Two small client components on an otherwise server-rendered page, which is the split this product
 * uses everywhere: the list is read on the server, inside the tenant context, and only the parts
 * that WRITE ship JavaScript.
 *
 * **Nothing here decides anything.** Whether a location may be created, renamed or closed is
 * decided by `src/server/tenant/locations.ts`, under the business row lock, on every request. These
 * components send a request and translate the answer. A refusal arrives as a `code`, never as a
 * sentence, so an Arabic merchant is never shown an English explanation that the server happened to
 * write in a log message.
 */

/** Translate a refusal by its code. An unrecognised one falls back to the generic line. */
function useRefusal() {
  const t = useTranslations("Locations");
  const tc = useTranslations("Common");
  return (code: string | undefined): string => {
    switch (code) {
      case "LOCATION_IS_MAIN":
        return t("errorIsMain");
      case "LOCATION_LAST_ACTIVE":
        return t("errorLastActive");
      case "LOCATION_STRANDS_PROGRAM":
        return t("errorStrandsProgram");
      case "NAME_TAKEN":
        return t("errorNameTaken");
      case "FORBIDDEN":
        return t("forbidden");
      default:
        return tc("genericError");
    }
  };
}

async function post(body: unknown): Promise<{ ok: boolean; code?: string }> {
  try {
    const response = await fetch("/api/staff/locations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (response.ok) return { ok: true };
    const payload = (await response.json().catch(() => null)) as { error?: { code?: string } } | null;
    return { ok: false, code: payload?.error?.code };
  } catch {
    return { ok: false };
  }
}

export function LocationCreateForm({ businessId }: { businessId: string }) {
  const t = useTranslations("Locations");
  const router = useRouter();
  const refusal = useRefusal();

  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setMessage(null);

    const result = await post({ action: "create", businessId, name, address: address.trim() || undefined });
    if (result.ok) {
      setName("");
      setAddress("");
      setMessage({ tone: "success", text: t("created") });
      router.refresh(); // the list above is server-rendered
    } else {
      setMessage({ tone: "danger", text: refusal(result.code) });
    }
    setPending(false);
  }

  return (
    <form onSubmit={onSubmit} data-testid="location-form" className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="location-name" label={t("nameLabel")}>
          <TextInput
            id="location-name"
            required
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
            data-testid="location-name"
          />
        </Field>
        <Field id="location-address" label={t("addressLabel")} hint={t("addressHint")}>
          <TextInput
            id="location-address"
            maxLength={200}
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            data-testid="location-address"
          />
        </Field>
      </div>

      {message ? (
        <Notice tone={message.tone} testId="location-message">
          {message.text}
        </Notice>
      ) : null}

      <Button type="submit" disabled={pending} testId="location-submit">
        {pending ? t("creating") : t("create")}
      </Button>
    </form>
  );
}

export function LocationRowControls({
  businessId,
  locationId,
  name,
  address,
  active,
  isDefault,
}: {
  businessId: string;
  locationId: string;
  name: string;
  address: string | null;
  active: boolean;
  isDefault: boolean;
}) {
  const t = useTranslations("Locations");
  const tc = useTranslations("Common");
  const router = useRouter();
  const refusal = useRefusal();

  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(name);
  const [draftAddress, setDraftAddress] = useState(address ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(body: unknown) {
    if (pending) return;
    setPending(true);
    setError(null);
    const result = await post(body);
    if (result.ok) {
      setEditing(false);
      router.refresh();
    } else {
      setError(refusal(result.code));
    }
    setPending(false);
  }

  if (editing) {
    return (
      <form
        className="space-y-3"
        data-testid={`location-edit-${locationId}`}
        onSubmit={(e) => {
          e.preventDefault();
          void run({ action: "update", businessId, locationId, name: draftName, address: draftAddress });
        }}
      >
        <Field id={`edit-name-${locationId}`} label={t("nameLabel")}>
          <TextInput
            id={`edit-name-${locationId}`}
            required
            maxLength={80}
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            data-testid="location-edit-name"
          />
        </Field>
        <Field id={`edit-address-${locationId}`} label={t("addressLabel")}>
          <TextInput
            id={`edit-address-${locationId}`}
            maxLength={200}
            value={draftAddress}
            onChange={(e) => setDraftAddress(e.target.value)}
          />
        </Field>
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" size="sm" disabled={pending} testId="location-save">
            {pending ? t("saving") : t("save")}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
            {tc("cancel")}
          </Button>
        </div>
      </form>
    );
  }

  return (
    <div className="space-y-2">
      {error ? <Notice tone="danger" testId={`location-error-${locationId}`}>{error}</Notice> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="secondary" onClick={() => setEditing(true)} testId="location-edit">
          {t("edit")}
        </Button>
        {/*
         * The main counter carries no close button at all, rather than a disabled one. A control
         * that exists and refuses is a promise the product does not keep; the badge beside the name
         * already says why this row is different.
         */}
        {isDefault ? null : active ? (
          <Button
            type="button"
            size="sm"
            variant="danger"
            disabled={pending}
            testId="location-deactivate"
            // A close is reversible — the row keeps its id and its history — but it stops the till
            // at that counter, so it asks first.
            onClick={() => {
              if (window.confirm(t("confirmDeactivate", { name }))) {
                void run({ action: "deactivate", businessId, locationId });
              }
            }}
          >
            {t("deactivate")}
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={pending}
            testId="location-reactivate"
            onClick={() => void run({ action: "activate", businessId, locationId })}
          >
            {t("reactivate")}
          </Button>
        )}
      </div>
    </div>
  );
}
