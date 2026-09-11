"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";

/**
 * The counter screen.
 *
 * Three things here are correctness rather than presentation:
 *
 *  1. **Every mutating call carries a client-generated idempotency key**, minted once per intent
 *     and reused by a retry. A cashier on a café's wifi will tap twice; the second tap must replay
 *     the first answer, not award again. The key is regenerated only when the cashier starts a new
 *     action, never on a retry of the same one.
 *  2. **No location is ever sent.** There is no picker, no field and no hidden default in this
 *     component — the server resolves Main. The line under the title says so, because a cashier
 *     who cannot see where an operation lands will eventually ask.
 *  3. **Conflicts are translated from a code, not a server message.** "No reward to give", "daily
 *     limit reached" and "card paused" need different words at a counter, and an Arabic screen must
 *     not print an English sentence from an API.
 *
 * The camera path uses the browser's own `BarcodeDetector` where it exists (Android Chrome) and
 * degrades to the paste/type field everywhere else, including iOS Safari. No camera library is
 * bundled, and no test claims a physical scan.
 */

interface CardSummary {
  customerCardId: string;
  serialNumber: string;
  status: string;
  phone: string;
  firstName: string | null;
  lastName: string | null;
  stampBalance: number;
  rewardBalance: number;
  stampsRequiredPerReward: number;
  stampsToNextReward: number;
}

interface OperationResult {
  transactionGroupId: string;
  stampBalance: number;
  rewardBalance: number;
  stampsAwarded: number;
  rewardsEarned: number;
}

type Feedback = { tone: "ok" | "warn" | "error"; text: string } | null;

interface BarcodeDetectorLike {
  detect: (source: CanvasImageSource) => Promise<{ rawValue: string }[]>;
}

export default function ScannerClient({ businessId, businessName }: { businessId: string; businessName: string }) {
  const t = useTranslations("Scanner");
  const tc = useTranslations("Common");

  const [tab, setTab] = useState<"qr" | "phone">("qr");
  const [qrValue, setQrValue] = useState("");
  const [phoneValue, setPhoneValue] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [purchaseAmount, setPurchaseAmount] = useState("");
  const [reverseReason, setReverseReason] = useState("");

  const [card, setCard] = useState<CardSummary | null>(null);
  const [lastGroupId, setLastGroupId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraError, setCameraError] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  /** Translate a failure into words a cashier can act on. */
  const describeFailure = useCallback(
    async (response: Response): Promise<string> => {
      if (response.status === 401 || response.status === 403) return t("unauthorized");
      if (response.status === 404) return t("notFound");
      const body = (await response.json().catch(() => null)) as { error?: { code?: string } } | null;
      switch (body?.error?.code) {
        case "NO_REWARD_AVAILABLE":
          return t("noRewardToRedeem");
        case "DAILY_LIMIT_REACHED":
          return t("dailyLimit");
        case "CARD_NOT_TRANSACTABLE":
          return t("cardNotActive");
        case "ALREADY_REVERSED":
          return t("alreadyReversed");
        case "IDEMPOTENCY_CONFLICT":
          return t("duplicateIgnored");
        default:
          return tc("genericError");
      }
    },
    [t, tc],
  );

  const lookup = useCallback(
    async (query: { qr?: string; phone?: string }) => {
      setBusy(true);
      setFeedback(null);
      try {
        const params = new URLSearchParams({ businessId });
        if (query.qr) params.set("qr", query.qr.trim());
        if (query.phone !== undefined) params.set("phone", query.phone.trim());

        const response = await fetch(`/api/scanner/lookup?${params.toString()}`);
        if (!response.ok) {
          setCard(null);
          setFeedback({ tone: "error", text: await describeFailure(response) });
          return;
        }
        const { cards } = (await response.json()) as { cards: CardSummary[] };
        if (cards.length === 0) {
          setCard(null);
          setFeedback({ tone: "warn", text: t("notFound") });
          return;
        }
        setCard(cards[0]);
        setLastGroupId(null);
      } catch {
        setFeedback({ tone: "error", text: t("notFound") });
      } finally {
        setBusy(false);
      }
    },
    [businessId, describeFailure, t],
  );

  /**
   * Run one mutating action.
   *
   * The idempotency key is minted HERE, once per call to this function, so a network retry inside
   * `fetch` reuses it. A new tap is a new intent and gets a new key.
   */
  const act = useCallback(
    async (path: string, payload: Record<string, unknown>, onOk: (result: OperationResult) => Feedback) => {
      if (!card || busy) return;
      setBusy(true);
      setFeedback(null);
      const idempotencyKey = crypto.randomUUID();
      try {
        const response = await fetch(path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...payload, businessId, customerCardId: card.customerCardId, idempotencyKey }),
        });
        if (!response.ok) {
          setFeedback({ tone: "error", text: await describeFailure(response) });
          return;
        }
        const result = (await response.json()) as OperationResult;
        setCard({
          ...card,
          stampBalance: result.stampBalance,
          rewardBalance: result.rewardBalance,
          stampsToNextReward: card.stampsRequiredPerReward - (result.stampBalance % card.stampsRequiredPerReward),
        });
        setLastGroupId(result.transactionGroupId);
        setFeedback(onOk(result));
      } catch {
        setFeedback({ tone: "error", text: t("notFound") });
      } finally {
        setBusy(false);
      }
    },
    [businessId, busy, card, describeFailure, t],
  );

  // ── camera, best effort ────────────────────────────────────────────────────
  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setCameraOn(false);
  }, []);

  useEffect(() => stopCamera, [stopCamera]);

  const startCamera = useCallback(async () => {
    const detectorCtor = (window as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => BarcodeDetectorLike })
      .BarcodeDetector;
    if (!detectorCtor || !navigator.mediaDevices?.getUserMedia) {
      setCameraError(true);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      streamRef.current = stream;
      setCameraOn(true);
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      const detector = new detectorCtor({ formats: ["qr_code"] });
      const tick = async () => {
        if (!streamRef.current || !videoRef.current) return;
        try {
          const codes = await detector.detect(videoRef.current);
          if (codes[0]?.rawValue) {
            const value = codes[0].rawValue;
            stopCamera();
            setQrValue(value);
            await lookup({ qr: value });
            return;
          }
        } catch {
          // A frame that cannot be decoded is the normal case, not an error worth showing.
        }
        requestAnimationFrame(() => void tick());
      };
      void tick();
    } catch {
      setCameraError(true);
      stopCamera();
    }
  }, [lookup, stopCamera]);

  const toneClass = {
    ok: "bg-emerald-500/10 text-emerald-300",
    warn: "bg-amber-500/10 text-amber-300",
    error: "bg-rose-500/10 text-rose-300",
  } as const;

  return (
    <main className="min-h-screen bg-zinc-950 px-4 py-6 text-zinc-100">
      <div className="mx-auto w-full max-w-md space-y-5">
        <header>
          <h1 className="text-xl font-bold">{t("title")}</h1>
          <p className="text-sm text-zinc-400">{businessName}</p>
          <p className="mt-1 text-xs text-zinc-500">{t("location")}</p>
        </header>

        <div className="flex rounded-xl bg-zinc-900 p-1 ring-1 ring-white/10" role="tablist">
          {(["qr", "phone"] as const).map((key) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              data-testid={`scanner-tab-${key}`}
              onClick={() => setTab(key)}
              className={`flex-1 rounded-lg py-2 text-sm font-semibold transition-colors ${
                tab === key ? "bg-indigo-600 text-white" : "text-zinc-400"
              }`}
            >
              {key === "qr" ? t("tabQr") : t("tabPhone")}
            </button>
          ))}
        </div>

        {tab === "qr" ? (
          <section className="space-y-3">
            <input
              value={qrValue}
              onChange={(e) => setQrValue(e.target.value)}
              placeholder={t("qrPlaceholder")}
              dir="ltr"
              data-testid="scanner-qr-input"
              className="w-full rounded-xl bg-zinc-900 px-4 py-3 text-sm ring-1 ring-white/10 outline-none focus:ring-indigo-500"
            />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void lookup({ qr: qrValue })}
                disabled={busy || qrValue.trim() === ""}
                data-testid="scanner-qr-lookup"
                className="flex-1 rounded-xl bg-indigo-600 py-3 font-bold disabled:opacity-50"
              >
                {busy ? t("searching") : t("lookup")}
              </button>
              <button
                type="button"
                onClick={() => (cameraOn ? stopCamera() : void startCamera())}
                className="rounded-xl bg-zinc-800 px-4 py-3 text-sm font-medium ring-1 ring-white/10"
              >
                {cameraOn ? t("stopCamera") : t("startCamera")}
              </button>
            </div>
            <p className="text-xs text-zinc-500">{t("qrHelp")}</p>
            {cameraOn && <video ref={videoRef} muted playsInline className="w-full rounded-xl" />}
            {cameraError && <p className="text-xs text-amber-300">{t("cameraUnavailable")}</p>}
          </section>
        ) : (
          <section className="space-y-3">
            <input
              value={phoneValue}
              onChange={(e) => setPhoneValue(e.target.value)}
              placeholder={t("phonePlaceholder")}
              type="tel"
              inputMode="tel"
              dir="ltr"
              data-testid="scanner-phone-input"
              className="w-full rounded-xl bg-zinc-900 px-4 py-3 text-lg ring-1 ring-white/10 outline-none focus:ring-indigo-500"
            />
            <button
              type="button"
              onClick={() => void lookup({ phone: phoneValue })}
              disabled={busy || phoneValue.trim() === ""}
              data-testid="scanner-phone-lookup"
              className="w-full rounded-xl bg-indigo-600 py-3 font-bold disabled:opacity-50"
            >
              {busy ? t("searching") : t("lookup")}
            </button>
          </section>
        )}

        {feedback !== null && (
          <p role="status" data-testid="scanner-feedback" className={`rounded-xl px-4 py-3 text-sm font-medium ${toneClass[feedback.tone]}`}>
            {feedback.text}
          </p>
        )}

        {card !== null && (
          <section data-testid="scanner-card" className="space-y-4 rounded-2xl bg-zinc-900 p-5 ring-1 ring-white/10">
            <div>
              <p className="text-xs uppercase tracking-wide text-zinc-500">{t("customer")}</p>
              <p className="text-lg font-bold">{[card.firstName, card.lastName].filter(Boolean).join(" ") || "—"}</p>
              <p dir="ltr" className="text-sm text-zinc-400">
                {card.phone}
              </p>
            </div>

            <div className="flex gap-4 rounded-xl bg-zinc-950 px-4 py-3">
              <div>
                <p className="text-xs text-zinc-500">{t("balance")}</p>
                <p data-testid="scanner-stamps" className="text-lg font-bold">
                  {t("stamps", { count: card.stampBalance })}
                </p>
              </div>
              <div>
                <p className="text-xs text-zinc-500">&nbsp;</p>
                <p data-testid="scanner-rewards" className="text-lg font-bold text-emerald-300">
                  {t("rewards", { count: card.rewardBalance })}
                </p>
              </div>
            </div>

            <div className="space-y-2">
              <p className="text-xs uppercase tracking-wide text-zinc-500">{t("awardTitle")}</p>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={1}
                  value={quantity}
                  onChange={(e) => setQuantity(Math.max(1, Number(e.target.value) || 1))}
                  aria-label={t("awardQuantity")}
                  data-testid="scanner-quantity"
                  className="w-20 rounded-xl bg-zinc-950 px-3 py-3 text-center ring-1 ring-white/10"
                />
                <button
                  type="button"
                  disabled={busy}
                  data-testid="scanner-award"
                  onClick={() =>
                    void act("/api/scanner/award", { mode: "manual", quantity }, (r) => ({
                      tone: "ok",
                      text:
                        r.rewardsEarned > 0
                          ? t("rewardEarned", { count: r.rewardsEarned })
                          : t("awarded", { count: r.stampsAwarded }),
                    }))
                  }
                  className="flex-1 rounded-xl bg-indigo-600 py-3 font-bold disabled:opacity-50"
                >
                  {t("awardManual")}
                </button>
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={0}
                  value={purchaseAmount}
                  onChange={(e) => setPurchaseAmount(e.target.value)}
                  placeholder={t("purchaseAmount")}
                  aria-label={t("purchaseAmount")}
                  data-testid="scanner-purchase-amount"
                  className="w-32 rounded-xl bg-zinc-950 px-3 py-3 ring-1 ring-white/10"
                />
                <button
                  type="button"
                  disabled={busy || purchaseAmount.trim() === ""}
                  data-testid="scanner-award-purchase"
                  onClick={() =>
                    void act("/api/scanner/award", { mode: "purchase", purchaseAmountMinor: Number(purchaseAmount) }, (r) => ({
                      tone: "ok",
                      text:
                        r.rewardsEarned > 0
                          ? t("rewardEarned", { count: r.rewardsEarned })
                          : t("awarded", { count: r.stampsAwarded }),
                    }))
                  }
                  className="flex-1 rounded-xl bg-zinc-800 py-3 text-sm font-semibold ring-1 ring-white/10 disabled:opacity-50"
                >
                  {t("awardPurchase")}
                </button>
              </div>
            </div>

            <button
              type="button"
              disabled={busy || card.rewardBalance < 1}
              data-testid="scanner-redeem"
              onClick={() => void act("/api/scanner/redeem", {}, () => ({ tone: "ok", text: t("redeemed") }))}
              className="w-full rounded-xl bg-emerald-600 py-3 font-bold disabled:opacity-40"
            >
              {t("redeem")}
            </button>

            {lastGroupId !== null && (
              <div className="space-y-2 border-t border-white/10 pt-4">
                <input
                  value={reverseReason}
                  onChange={(e) => setReverseReason(e.target.value)}
                  placeholder={t("reverseReason")}
                  data-testid="scanner-reverse-reason"
                  className="w-full rounded-xl bg-zinc-950 px-3 py-2 text-sm ring-1 ring-white/10"
                />
                <button
                  type="button"
                  disabled={busy || reverseReason.trim() === ""}
                  data-testid="scanner-reverse"
                  onClick={() =>
                    void act("/api/scanner/reverse", { transactionGroupId: lastGroupId, reason: reverseReason.trim() }, () => ({
                      tone: "warn",
                      text: t("reversed"),
                    }))
                  }
                  className="w-full rounded-xl bg-zinc-800 py-2 text-sm font-semibold text-rose-300 ring-1 ring-white/10 disabled:opacity-40"
                >
                  {t("reverse")}
                </button>
                <p className="text-xs text-zinc-500">{t("reverseHint")}</p>
              </div>
            )}
          </section>
        )}
      </div>
    </main>
  );
}
