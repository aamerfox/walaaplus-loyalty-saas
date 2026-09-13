"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Wordmark } from "@/components/brand/Wordmark";
import { browserQrCameraDeps, selectQrEngine, startQrCamera, type QrCameraFailure } from "./qr-camera";

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
 * a dynamically imported ZXing decoder where it does not (iOS Safari). It used to do only the
 * first, and told an iPhone it had no camera — before any permission prompt, on a device holding
 * two. All the decoding logic lives in ./qr-camera.ts with its browser capabilities injected, so
 * "Safari has getUserMedia and no BarcodeDetector" is a test rather than a merchant's bug report.
 *
 * No test here claims a physical scan. Real-device verification stays a manual check.
 */

interface CardBase {
  customerCardId: string;
  serialNumber: string;
  status: string;
  phone: string;
  firstName: string | null;
  lastName: string | null;
  templateId: string;
  programName: string;
  earnMode: "MANUAL" | "PER_VISIT" | "SPEND_BLOCK";
  /** The counters this card's own pinned version allows. `null` means the main counter only. */
  pinnedLocations: string[] | null;
}

interface StampCard extends CardBase {
  cardType: "STAMP";
  stampBalance: number;
  rewardBalance: number;
  stampsRequiredPerReward: number;
  stampsToNextReward: number;
}

interface PointsCard extends CardBase {
  cardType: "POINTS";
  pointBalance: number;
  pointsLabel: string | null;
  tiers: { id: string; name: string; requiredPoints: number; affordable: boolean }[];
}

type CardSummary = StampCard | PointsCard;

/**
 * What the server says this member may do, and where.
 *
 * `programs` describes the LIVE version of each program, which is what the enrolment picker needs.
 * `usableLocations` is every counter that is open and assigned to this member right now, and it is
 * what an existing CARD is measured against — because a card is served under the version it was
 * issued with, not under whatever version the program has since published.
 */
export interface ScannerScope {
  programs: { templateId: string; name: string; cardType: "STAMP" | "POINTS"; locations: { id: string; name: string }[] | null }[];
  defaultLocationId: string | null;
  usableLocations: { id: string; name: string }[];
}

interface OperationResult {
  transactionGroupId: string;
  stampBalance?: number;
  rewardBalance?: number;
  stampsAwarded?: number;
  rewardsEarned?: number;
  pointBalance?: number;
  pointsDelta?: number;
}

type Feedback = { tone: "ok" | "warn" | "error"; text: string } | null;

export default function ScannerClient({
  businessId,
  businessName,
  scope,
}: {
  businessId: string;
  businessName: string;
  scope: ScannerScope;
}) {
  const t = useTranslations("Scanner");
  const tc = useTranslations("Common");
  const tn = useTranslations("Navigation");
  /*
   * The consent wording is its own namespace, not the screen's. `ENROLLMENT_CONSENT_VERSION` is
   * stamped against these exact strings, so the text a customer agrees to must not quietly become
   * a different sentence because the screen that shows it moved.
   */
  const tConsent = useTranslations("Consent");

  const [tab, setTab] = useState<"qr" | "phone">("qr");
  const [qrValue, setQrValue] = useState("");
  const [phoneValue, setPhoneValue] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [purchaseAmount, setPurchaseAmount] = useState("");
  const [reverseReason, setReverseReason] = useState("");

  const [card, setCard] = useState<CardSummary | null>(null);
  /** Set when a phone search found nobody, so the counter can offer to sign them up. */
  const [enrollPhone, setEnrollPhone] = useState<string | null>(null);
  const [enrollFirstName, setEnrollFirstName] = useState("");
  const [enrollLastName, setEnrollLastName] = useState("");
  const [enrollConsent, setEnrollConsent] = useState(false);
  /**
   * The invitation the customer is showing, if any.
   *
   * Held as whatever staff typed, scanned or pasted — a full `https://…/share#<capability>`, or
   * just the value after the `#` if their scanner is configured that way. It is normalised to the
   * fragment at send time, never here, so the field keeps showing what they actually entered.
   */
  const [referralInput, setReferralInput] = useState("");
  /** The customer's own card link, shown after enrolling or after a staff restore. */
  const [cardLink, setCardLink] = useState<{ url: string; qr: string } | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);
  const [lastGroupId, setLastGroupId] = useState<string | null>(null);
  /**
   * Which counter this operation happened at.
   *
   * Empty until the cashier chooses, and the actions stay disabled until they do — because the
   * server **refuses to guess** when a program runs at several locations, and a screen that picked
   * one for them would be choosing which branch gets the revenue.
   */
  const [locationId, setLocationId] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraFailure, setCameraFailure] = useState<QrCameraFailure | null>(null);
  const [cameraStarting, setCameraStarting] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  /** The live camera's release function, or null. Set only while a camera is running. */
  const cameraStopRef = useRef<(() => void) | null>(null);
  /** Guards the whole decode path: one scan is one lookup, however many callbacks arrive. */
  const decodingRef = useRef(false);

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
      setEnrollPhone(null);
      setCardLink(null);
      setLocationId("");
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
          /*
           * Nobody found. On a PHONE search that is the start of an enrolment, not a dead end:
           * this is where a customer without a card gets one, now that the public join page is
           * gone. A QR that matches nothing is different - it is a card from somewhere else, or a
           * mistyped code - so it stays a plain "not found".
           */
          if (query.phone !== undefined && query.phone.trim() !== "") {
            setEnrollPhone(query.phone.trim());
            setFeedback({ tone: "warn", text: t("notFoundOfferEnroll") });
          } else {
            setFeedback({ tone: "warn", text: t("notFound") });
          }
          return;
        }
        const found = cards[0];
        setCard(found);
        setLastGroupId(null);
        /*
         * One counter to choose from is not a choice. A program that runs at Main only sends no
         * location at all (the server refuses one), and a program that lists exactly one gets it
         * without asking — the picker appears only when there is a decision to make.
         */
        /*
         * Derived from the CARD's pinned version, intersected with the counters this member may use
         * now. A program that has since published a new version does not move a card that was
         * issued before it.
         */
        const usable =
          found.pinnedLocations === null
            ? null
            : scope.usableLocations.filter((l) => found.pinnedLocations!.includes(l.id));
        setLocationId(usable?.length === 1 ? usable[0].id : "");
      } catch {
        setFeedback({ tone: "error", text: t("notFound") });
      } finally {
        setBusy(false);
      }
    },
    [businessId, describeFailure, scope, t],
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
          body: JSON.stringify({
            ...payload,
            businessId,
            customerCardId: card.customerCardId,
            idempotencyKey,
            // Only when the cashier actually chose one. A Phase 1a program refuses a location even
            // if it is the right one, so an empty choice must send no field at all.
            ...(locationId !== "" ? { locationId } : {}),
          }),
        });
        if (!response.ok) {
          setFeedback({ tone: "error", text: await describeFailure(response) });
          return;
        }
        const result = (await response.json()) as OperationResult;
        if (card.cardType === "STAMP" && result.stampBalance !== undefined) {
          setCard({
            ...card,
            stampBalance: result.stampBalance,
            rewardBalance: result.rewardBalance ?? card.rewardBalance,
            stampsToNextReward: card.stampsRequiredPerReward - (result.stampBalance % card.stampsRequiredPerReward),
          });
        } else if (card.cardType === "POINTS" && result.pointBalance !== undefined) {
          const pointBalance = result.pointBalance;
          setCard({
            ...card,
            pointBalance,
            // Affordability is recomputed from the balance the SERVER just returned, never from a
            // local sum: the two disagreeing is how a cashier ends up pressing a reward the card
            // cannot pay for.
            tiers: card.tiers.map((tier) => ({ ...tier, affordable: pointBalance >= tier.requiredPoints })),
          });
        }
        setLastGroupId(result.transactionGroupId);
        setFeedback(onOk(result));
      } catch {
        setFeedback({ tone: "error", text: t("notFound") });
      } finally {
        setBusy(false);
      }
    },
    [businessId, busy, card, describeFailure, locationId, t],
  );

  // ── camera ─────────────────────────────────────────────────────────────────
  const cameraDeps = useMemo(() => browserQrCameraDeps(), []);
  /**
   * Whether this browser can scan at all, asked WITHOUT touching the camera.
   *
   * Capability and consent are different questions. Conflating them is what put "the camera is
   * not available on this device" in front of an iPhone that had two working cameras and had
   * never been asked for either.
   */
  const engine = useMemo(() => selectQrEngine(cameraDeps), [cameraDeps]);

  const stopCamera = useCallback(() => {
    cameraStopRef.current?.();
    cameraStopRef.current = null;
    setCameraOn(false);
    setCameraStarting(false);
  }, []);

  // Unmount, a route change, a tab switch away from this screen: the camera goes with it.
  useEffect(() => stopCamera, [stopCamera]);

  const startCamera = useCallback(async () => {
    if (cameraStarting || cameraStopRef.current) return;

    if (engine === "unsupported") {
      setCameraFailure("unsupported");
      return;
    }

    setCameraFailure(null);
    setCameraStarting(true);
    decodingRef.current = false;

    /*
     * Show the preview BEFORE asking for the camera, and pass a getter rather than an element.
     *
     * Both halves matter, and each fixes a real phone. Setting `cameraOn` first means the
     * `<video>` is visible — not `display:none` — by the time a granted stream is attached and
     * played; a hidden video is not reliably played or decoded. Passing a getter means
     * `startQrCamera` waits for the element instead of reading a ref that React has not filled
     * in yet, which is how a Huawei granted permission and then showed nothing at all.
     */
    setCameraOn(true);

    // Everything from here is behind the cashier's tap, which is the only moment iOS Safari will
    // show its permission prompt.
    const started = await startQrCamera(cameraDeps, () => videoRef.current, (value) => {
      // `startQrCamera` has already released the stream and the decoder before calling this, and
      // fires it at most once; this guard covers the component's own re-entry as well.
      if (decodingRef.current) return;
      decodingRef.current = true;
      cameraStopRef.current = null;
      setCameraOn(false);
      setQrValue(value);
      void lookup({ qr: value });
    });

    setCameraStarting(false);
    if (!started.ok) {
      setCameraFailure(started.failure);
      setCameraOn(false);
      return;
    }
    cameraStopRef.current = started.stop;
  }, [cameraDeps, cameraStarting, engine, lookup]);

  const cameraMessage =
    cameraFailure === "denied"
      ? t("cameraDenied")
      : cameraFailure === "unsupported"
        ? t("cameraUnsupported")
        : cameraFailure === "failed"
          ? t("cameraFailed")
          : null;

  /**
   * Sign the customer up at the counter.
   *
   * The phone number comes from the search that just failed, not from a second field: retyping it
   * is how a card ends up on the wrong number. Business, program, enrolment source and location
   * are all resolved on the server from the session - this body carries none of them.
   */
  const enrollAtCounter = useCallback(async () => {
    if (!enrollPhone || busy) return;
    /*
     * The fragment, extracted HERE — in the browser, before anything is sent.
     *
     * A capability in a path or a query string is written into every access log, proxy log and
     * error report between this device and the server. Taking everything after the `#` and sending
     * only that, in a POST body, is what keeps the one authenticated route allowed to see an
     * invitation from also being the one that records it somewhere nobody meant.
     *
     * A bare token with no `#` is accepted too: a hardware scanner can be configured to emit one,
     * and refusing it would push staff towards pasting the whole URL somewhere else to trim it.
     */
    const referralToken = referralInput.includes("#")
      ? referralInput.slice(referralInput.indexOf("#") + 1).trim()
      : referralInput.trim();
    setBusy(true);
    setFeedback(null);
    try {
      const response = await fetch("/api/scanner/enroll", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          businessId,
          phone: enrollPhone,
          firstName: enrollFirstName.trim() || undefined,
          lastName: enrollLastName.trim() || undefined,
          marketingConsent: enrollConsent,
          referralToken: referralToken || undefined,
        }),
      });
      if (!response.ok) {
        setFeedback({ tone: "error", text: await describeFailure(response) });
        return;
      }
      const result = (await response.json()) as {
        created: boolean;
        cardUrl: string;
        cardQrSvg: string;
        referral?: "RECORDED" | "NOT_ACCEPTED";
      };
      setEnrollFirstName("");
      setEnrollLastName("");
      setEnrollConsent(false);
      setReferralInput("");

      /*
       * Load the card itself, so the cashier can award a stamp without searching again. This runs
       * BEFORE the link is shown, not after: `lookup` clears the enrolment offer and any link on
       * screen, which is right when a search starts and would wipe the link we are about to hand
       * over if it ran second.
       */
      await lookup({ phone: enrollPhone });
      setCardLink({ url: result.cardUrl, qr: result.cardQrSvg });

      /*
       * The enrolment is what succeeded, so it is what the message leads with. An invitation that
       * could not be used is a second sentence, not a failure — and it says only that, because the
       * referring customer is never named, shown or implied to a member of staff.
       */
      const enrolled = result.created ? t("enrolled") : t("enrolledAlready");
      const referralNote =
        result.referral === "RECORDED"
          ? ` ${t("referralRecorded")}`
          : result.referral === "NOT_ACCEPTED"
            ? ` ${t("referralNotAccepted")}`
            : "";
      setFeedback({
        tone: result.referral === "NOT_ACCEPTED" ? "warn" : "ok",
        text: `${enrolled}${referralNote}`,
      });
    } catch {
      setFeedback({ tone: "error", text: tc("genericError") });
    } finally {
      setBusy(false);
    }
  }, [businessId, busy, describeFailure, enrollConsent, enrollFirstName, enrollLastName, enrollPhone, lookup, referralInput, t, tc]);

  /**
   * Show a customer their own card link again — the only restore path Phase 1a has, and the reason
   * the public "type your number" page could be removed without stranding anyone.
   */
  const revealCardLink = useCallback(async () => {
    if (!card || busy) return;
    setBusy(true);
    try {
      const response = await fetch("/api/scanner/card-link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ businessId, customerCardId: card.customerCardId }),
      });
      if (!response.ok) {
        setFeedback({ tone: "error", text: await describeFailure(response) });
        return;
      }
      const result = (await response.json()) as { cardUrl: string; cardQrSvg: string };
      setCardLink({ url: result.cardUrl, qr: result.cardQrSvg });
    } catch {
      setFeedback({ tone: "error", text: tc("genericError") });
    } finally {
      setBusy(false);
    }
  }, [businessId, busy, card, describeFailure, tc]);

  const copyCardLink = useCallback(async () => {
    if (!cardLink) return;
    try {
      await navigator.clipboard.writeText(cardLink.url);
      setLinkCopied(true);
      window.setTimeout(() => setLinkCopied(false), 2500);
    } catch {
      // Clipboard access is refused often enough - insecure origin, a stale gesture, a locked-down
      // device - and the link is on screen in a selectable field, so let them copy it themselves.
      (document.getElementById("customer-card-link") as HTMLInputElement | null)?.select();
    }
  }, [cardLink]);

  /**
   * The counters this card's program offers THIS member, or null for a Main-only program.
   *
   * Read from the scope the server resolved, not from the card: the card says which program it
   * belongs to, and the server says where that program runs and where this member may stand. A
   * picker built from anything else could offer an option the write would then refuse.
   */
  const programLocations =
    card === null || card.pinnedLocations === null
      ? null
      : scope.usableLocations.filter((l) => card.pinnedLocations!.includes(l.id));

  /**
   * Every counter this card's version runs at is closed, or none of them is assigned to this member.
   *
   * It is a real state now that counters can be closed and versions can name them: the card is
   * valid, the program is live, and this till still cannot serve it. Saying so is the whole fix —
   * the alternative is enabled buttons and a server refusal with a customer waiting.
   */
  const noUsableCounter = programLocations !== null && programLocations.length === 0;

  /**
   * Every write is blocked until a required counter is chosen.
   *
   * The server refuses to guess between several locations, so a disabled button is the honest
   * version of that refusal — it fails before the request rather than after it, and the line under
   * the picker says why.
   */
  const actionsBlocked =
    busy || noUsableCounter || (programLocations !== null && programLocations.length > 1 && locationId === "");

  const toneClass = {
    ok: "bg-mint-500/15 text-mint-500",
    warn: "bg-amber-500/10 text-amber-300",
    error: "bg-danger-bg/20 text-white",
  } as const;

  return (
    <main className="min-h-screen bg-navy-950 px-4 py-6 text-white">
      <div className="mx-auto w-full max-w-md space-y-5">
        {/*
          * The counter's own header: the product's mark, then which account this till is serving.
          *
          * The business name is LABELLED and small. It used to sit under the title at body size,
          * which on the staging tenant made "TrueBiznes" read as the name of the app.
          *
          * The old third line promised every operation was recorded at Main. That stopped being
          * true when programs gained locations, so it is gone: the card panel below names the
          * program and the counter for the card actually in hand, which is the honest place for it.
          */}
        <header className="flex items-start justify-between gap-4">
          <div>
            <Wordmark tone="white" height={22} className="h-[22px] w-auto" />
            <h1 className="mt-3 font-display text-xl font-extrabold">{t("title")}</h1>
          </div>
          <div className="min-w-0 text-end">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-white/55">{tn("businessLabel")}</p>
            <p className="truncate text-sm font-semibold text-white/90" data-testid="scanner-business">
              {businessName}
            </p>
          </div>
        </header>

        <div className="flex rounded-xl bg-navy-900 p-1 ring-1 ring-white/10" role="tablist">
          {(["qr", "phone"] as const).map((key) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              data-testid={`scanner-tab-${key}`}
              onClick={() => setTab(key)}
              className={`flex-1 rounded-lg py-2 text-sm font-semibold transition-colors ${
                tab === key ? "bg-turquoise-500 text-navy-950" : "text-white/70"
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
              className="w-full rounded-xl bg-navy-900 px-4 py-3 text-sm ring-1 ring-white/10 outline-none focus:ring-turquoise-500"
            />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void lookup({ qr: qrValue })}
                disabled={busy || qrValue.trim() === ""}
                data-testid="scanner-qr-lookup"
                className="flex-1 rounded-xl bg-turquoise-500 py-3 font-bold text-navy-950 disabled:opacity-50"
              >
                {busy ? t("searching") : t("lookup")}
              </button>
              <button
                type="button"
                onClick={() => (cameraOn ? stopCamera() : void startCamera())}
                disabled={cameraStarting || engine === "unsupported"}
                data-testid="scanner-camera-toggle"
                className="rounded-xl bg-white/10 px-4 py-3 text-sm font-medium ring-1 ring-white/10 disabled:opacity-50"
              >
                {cameraOn ? t("stopCamera") : t("startCamera")}
              </button>
            </div>
            <p className="text-xs text-white/55">{t("qrHelp")}</p>

            {/*
              Always in the DOM, hidden when idle. The stream is attached to this element before
              React re-renders, so a version that mounted it only once `cameraOn` flipped attached
              to nothing — the previous one did exactly that, and the decode loop died on its
              first frame.
            */}
            <video
              ref={videoRef}
              muted
              playsInline
              autoPlay
              data-testid="scanner-video"
              hidden={!cameraOn}
              className="w-full rounded-xl"
            />

            {cameraOn && !cameraStarting && (
              <p data-testid="scanner-camera-active" className="text-xs text-mint-500">
                {t("cameraScanning")}
              </p>
            )}
            {cameraStarting && (
              <p data-testid="scanner-camera-starting" className="text-xs text-white/70">
                {t("cameraStarting")}
              </p>
            )}
            {cameraMessage !== null && (
              <p role="status" data-testid="scanner-camera-message" className="text-xs text-amber-300">
                {cameraMessage}
              </p>
            )}
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
              className="w-full rounded-xl bg-navy-900 px-4 py-3 text-lg ring-1 ring-white/10 outline-none focus:ring-turquoise-500"
            />
            <button
              type="button"
              onClick={() => void lookup({ phone: phoneValue })}
              disabled={busy || phoneValue.trim() === ""}
              data-testid="scanner-phone-lookup"
              className="w-full rounded-xl bg-turquoise-500 py-3 font-bold text-navy-950 disabled:opacity-50"
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

        {enrollPhone !== null && (
          <section data-testid="scanner-enroll" className="space-y-3 rounded-2xl bg-navy-900 p-5 ring-1 ring-white/10">
            <div>
              <p className="text-xs uppercase tracking-wide text-white/55">{t("enrollTitle")}</p>
              <p dir="ltr" data-testid="scanner-enroll-phone" className="text-lg font-bold">
                {enrollPhone}
              </p>
            </div>

            <input
              value={enrollFirstName}
              onChange={(e) => setEnrollFirstName(e.target.value)}
              placeholder={t("enrollFirstName")}
              maxLength={80}
              data-testid="scanner-enroll-first-name"
              className="w-full rounded-xl bg-navy-950/60 px-4 py-3 text-sm ring-1 ring-white/10 outline-none focus:ring-turquoise-500"
            />
            <input
              value={enrollLastName}
              onChange={(e) => setEnrollLastName(e.target.value)}
              placeholder={t("enrollLastName")}
              maxLength={80}
              data-testid="scanner-enroll-last-name"
              className="w-full rounded-xl bg-navy-950/60 px-4 py-3 text-sm ring-1 ring-white/10 outline-none focus:ring-turquoise-500"
            />

            {/* Read aloud, ticked in front of the customer. The server stamps which wording and when. */}
            <label className="flex items-start gap-3 text-sm text-white/80">
              <input
                type="checkbox"
                checked={enrollConsent}
                onChange={(e) => setEnrollConsent(e.target.checked)}
                data-testid="scanner-enroll-consent"
                className="mt-0.5 h-5 w-5 rounded"
              />
              <span>{tConsent("consentLabel")}</span>
            </label>
            <p className="text-xs text-white/55">{tConsent("privacyNote")}</p>
            <p className="text-xs text-white/55">{t("enrollReadAloud")}</p>

            {/*
              * Optional, and last, because it is the only field that is not about the person in
              * front of you. Staff paste or scan whatever the customer is showing; the fragment is
              * taken from it on this device and the rest never leaves the browser.
              */}
            <div className="space-y-1">
              <label htmlFor="scanner-referral" className="block text-xs uppercase tracking-wide text-white/55">
                {t("referralLabel")}
              </label>
              <input
                id="scanner-referral"
                value={referralInput}
                onChange={(e) => setReferralInput(e.target.value)}
                placeholder={t("referralPlaceholder")}
                maxLength={400}
                dir="ltr"
                autoComplete="off"
                spellCheck={false}
                data-testid="scanner-referral-input"
                className="w-full rounded-xl bg-navy-950/60 px-4 py-3 text-sm ring-1 ring-white/10 outline-none focus:ring-turquoise-500"
              />
              <p className="text-xs text-white/55">{t("referralHint")}</p>
            </div>

            <button
              type="button"
              onClick={() => void enrollAtCounter()}
              disabled={busy}
              data-testid="scanner-enroll-submit"
              className="w-full rounded-xl bg-turquoise-500 py-3 font-bold text-navy-950 disabled:opacity-50"
            >
              {busy ? t("searching") : t("enrollSubmit")}
            </button>
          </section>
        )}

        {cardLink !== null && (
          <section data-testid="scanner-card-link" className="space-y-3 rounded-2xl bg-navy-900 p-5 ring-1 ring-white/10">
            <p className="text-xs uppercase tracking-wide text-white/55">{t("cardLinkTitle")}</p>
            <div
              data-testid="scanner-card-qr"
              className="mx-auto w-fit rounded-xl bg-white p-3"
              dangerouslySetInnerHTML={{ __html: cardLink.qr }}
            />
            <input
              id="customer-card-link"
              data-testid="scanner-card-link-url"
              readOnly
              dir="ltr"
              value={cardLink.url}
              onFocus={(e) => e.currentTarget.select()}
              className="w-full rounded-xl bg-navy-950/60 px-4 py-3 font-mono text-xs ring-1 ring-white/10"
            />
            <button
              type="button"
              onClick={() => void copyCardLink()}
              data-testid="scanner-card-link-copy"
              className="w-full rounded-xl bg-white/10 py-3 text-sm font-medium ring-1 ring-white/10"
            >
              {linkCopied ? t("cardLinkCopied") : t("cardLinkCopy")}
            </button>
            <p className="text-xs text-white/55">{t("cardLinkHelp")}</p>
          </section>
        )}

        {card !== null && (
          <section data-testid="scanner-card" className="space-y-4 rounded-2xl bg-navy-900 p-5 ring-1 ring-white/10">
            <div>
              <p className="text-xs uppercase tracking-wide text-white/55">{t("customer")}</p>
              <p className="text-lg font-bold">{[card.firstName, card.lastName].filter(Boolean).join(" ") || "—"}</p>
              <p dir="ltr" className="text-sm text-white/70">
                {card.phone}
              </p>
            </div>

            {/* Which program this card belongs to. A merchant running two of them needs to see it
                before awarding anything, and the balance below means nothing without it. */}
            <p data-testid="scanner-program" className="rounded-xl bg-navy-950/60 px-4 py-2 text-sm">
              <span className="text-white/55">{t("programLabel")} </span>
              <span className="font-semibold">{card.programName}</span>
              <span className="ms-2 rounded-full bg-white/10 px-2 py-0.5 text-xs text-white/80">
                {t(`cardType.${card.cardType}`)}
              </span>
            </p>

            {/* The counter. Present only when there is a real choice; required when there is. */}
            {noUsableCounter && (
              <p role="status" data-testid="scanner-no-counter" className="rounded-xl bg-amber-500/10 px-3 py-2 text-sm text-amber-300">
                {t("noUsableCounter")}
              </p>
            )}

            {programLocations !== null && programLocations.length > 0 && (
              <div data-testid="scanner-location">
                <label htmlFor="scanner-location-select" className="text-xs uppercase tracking-wide text-white/55">
                  {t("locationLabel")}
                </label>
                <select
                  id="scanner-location-select"
                  value={locationId}
                  onChange={(e) => setLocationId(e.target.value)}
                  data-testid="scanner-location-select"
                  className="mt-1 w-full rounded-xl bg-navy-950/60 px-4 py-3 ring-1 ring-white/10"
                >
                  <option value="">{t("locationChoose")}</option>
                  {programLocations.map((location) => (
                    <option key={location.id} value={location.id}>
                      {location.name}
                    </option>
                  ))}
                </select>
                {locationId === "" && (
                  <p role="status" data-testid="scanner-location-required" className="mt-1 text-xs text-amber-300">
                    {t("locationRequired")}
                  </p>
                )}
              </div>
            )}

            <button
              type="button"
              onClick={() => void revealCardLink()}
              disabled={busy}
              data-testid="scanner-reveal-link"
              className="w-full rounded-xl bg-white/10 py-2 text-sm font-medium ring-1 ring-white/10 disabled:opacity-50"
            >
              {t("revealCardLink")}
            </button>

            {card.cardType === "STAMP" ? (
              <>
                <div className="flex gap-4 rounded-xl bg-navy-950/60 px-4 py-3">
                  <div>
                    <p className="text-xs text-white/55">{t("balance")}</p>
                    <p data-testid="scanner-stamps" className="text-lg font-bold">
                      {t("stamps", { count: card.stampBalance })}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-white/55">&nbsp;</p>
                    <p data-testid="scanner-rewards" className="text-lg font-bold text-mint-500">
                      {t("rewards", { count: card.rewardBalance })}
                    </p>
                  </div>
                </div>

                <div className="space-y-2">
                  <p className="text-xs uppercase tracking-wide text-white/55">{t("awardTitle")}</p>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min={1}
                      value={quantity}
                      onChange={(e) => setQuantity(Math.max(1, Number(e.target.value) || 1))}
                      aria-label={t("awardQuantity")}
                      data-testid="scanner-quantity"
                      className="w-20 rounded-xl bg-navy-950/60 px-3 py-3 text-center ring-1 ring-white/10"
                    />
                    <button
                      type="button"
                      disabled={actionsBlocked}
                      data-testid="scanner-award"
                      onClick={() =>
                        void act("/api/scanner/award", { mode: "manual", quantity }, (r) => ({
                          tone: "ok",
                          text:
                            (r.rewardsEarned ?? 0) > 0
                              ? t("rewardEarned", { count: r.rewardsEarned ?? 0 })
                              : t("awarded", { count: r.stampsAwarded ?? 0 }),
                        }))
                      }
                      className="flex-1 rounded-xl bg-turquoise-500 py-3 font-bold text-navy-950 disabled:opacity-50"
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
                      className="min-w-0 flex-1 rounded-xl bg-navy-950/60 px-3 py-3 text-sm ring-1 ring-white/10"
                    />
                    <button
                      type="button"
                      disabled={actionsBlocked || purchaseAmount.trim() === ""}
                      data-testid="scanner-award-purchase"
                      onClick={() =>
                        void act(
                          "/api/scanner/award",
                          { mode: "purchase", purchaseAmountMinor: Number(purchaseAmount) },
                          (r) => ({
                            tone: "ok",
                            text:
                              (r.rewardsEarned ?? 0) > 0
                                ? t("rewardEarned", { count: r.rewardsEarned ?? 0 })
                                : t("awarded", { count: r.stampsAwarded ?? 0 }),
                          }),
                        )
                      }
                      className="flex-1 rounded-xl bg-white/10 py-3 text-sm font-semibold ring-1 ring-white/10 disabled:opacity-50"
                    >
                      {t("awardPurchase")}
                    </button>
                  </div>
                </div>

                <button
                  type="button"
                  disabled={actionsBlocked || card.rewardBalance < 1}
                  data-testid="scanner-redeem"
                  onClick={() => void act("/api/scanner/redeem", {}, () => ({ tone: "ok", text: t("redeemed") }))}
                  className="w-full rounded-xl bg-mint-500 py-3 font-bold text-navy-950 disabled:opacity-40"
                >
                  {t("redeem")}
                </button>
              </>
            ) : (
              <>
                <div className="rounded-xl bg-navy-950/60 px-4 py-3">
                  <p className="text-xs text-white/55">{card.pointsLabel ?? t("pointsBalance")}</p>
                  <p data-testid="scanner-points" className="text-lg font-bold tabular-nums">
                    {t("points", { count: card.pointBalance })}
                  </p>
                </div>

                <div className="space-y-2">
                  <p className="text-xs uppercase tracking-wide text-white/55">{t("awardTitle")}</p>

                  {/* The earn mode decides which buttons exist. Offering "per visit" on a
                      spend-block program would be offering a request the engine refuses. */}
                  {card.earnMode === "SPEND_BLOCK" && (
                    <div className="flex items-center gap-2">
                      <input
                        type="number"
                        min={0}
                        value={purchaseAmount}
                        onChange={(e) => setPurchaseAmount(e.target.value)}
                        placeholder={t("purchaseAmount")}
                        aria-label={t("purchaseAmount")}
                        data-testid="scanner-points-purchase-amount"
                        className="min-w-0 flex-1 rounded-xl bg-navy-950/60 px-3 py-3 text-sm ring-1 ring-white/10"
                      />
                      <button
                        type="button"
                        disabled={actionsBlocked || purchaseAmount.trim() === ""}
                        data-testid="scanner-points-purchase"
                        onClick={() =>
                          void act(
                            "/api/scanner/points",
                            { mode: "purchase", purchaseAmountMinor: Number(purchaseAmount) },
                            (r) => ({ tone: "ok", text: t("pointsAwarded", { count: r.pointsDelta ?? 0 }) }),
                          )
                        }
                        className="flex-1 rounded-xl bg-turquoise-500 py-3 font-bold text-navy-950 disabled:opacity-50"
                      >
                        {t("awardPurchase")}
                      </button>
                    </div>
                  )}

                  {card.earnMode === "PER_VISIT" && (
                    <button
                      type="button"
                      disabled={actionsBlocked}
                      data-testid="scanner-points-visit"
                      onClick={() =>
                        void act("/api/scanner/points", { mode: "visit" }, (r) => ({
                          tone: "ok",
                          text: t("pointsAwarded", { count: r.pointsDelta ?? 0 }),
                        }))
                      }
                      className="w-full rounded-xl bg-turquoise-500 py-3 font-bold text-navy-950 disabled:opacity-50"
                    >
                      {t("awardVisit")}
                    </button>
                  )}

                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min={1}
                      value={quantity}
                      onChange={(e) => setQuantity(Math.max(1, Number(e.target.value) || 1))}
                      aria-label={t("awardQuantity")}
                      data-testid="scanner-points-quantity"
                      className="w-20 rounded-xl bg-navy-950/60 px-3 py-3 text-center ring-1 ring-white/10"
                    />
                    <button
                      type="button"
                      disabled={actionsBlocked}
                      data-testid="scanner-points-award"
                      onClick={() =>
                        void act("/api/scanner/points", { mode: "manual", quantity }, (r) => ({
                          tone: "ok",
                          text: t("pointsAwarded", { count: r.pointsDelta ?? 0 }),
                        }))
                      }
                      className="flex-1 rounded-xl bg-white/10 py-3 text-sm font-semibold ring-1 ring-white/10 disabled:opacity-50"
                    >
                      {t("awardManual")}
                    </button>
                  </div>
                </div>

                <div className="space-y-2">
                  <p className="text-xs uppercase tracking-wide text-white/55">{t("redeemTitle")}</p>
                  {card.tiers.length === 0 ? (
                    <p className="text-sm text-white/55">{t("noTiers")}</p>
                  ) : (
                    <ul className="space-y-2" data-testid="scanner-tiers">
                      {card.tiers.map((tier) => (
                        <li key={tier.id}>
                          <button
                            type="button"
                            disabled={actionsBlocked || !tier.affordable}
                            data-testid={`scanner-redeem-tier-${tier.id}`}
                            onClick={() =>
                              void act("/api/scanner/points", { mode: "redeem", rewardTierId: tier.id }, () => ({
                                tone: "ok",
                                text: t("redeemed"),
                              }))
                            }
                            className="flex w-full items-center justify-between gap-3 rounded-xl bg-mint-500 px-4 py-3 text-start font-bold text-navy-950 disabled:bg-white/10 disabled:text-white/40 disabled:opacity-100"
                          >
                            <span>{tier.name}</span>
                            <span className="tabular-nums text-sm font-semibold">
                              {t("points", { count: tier.requiredPoints })}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </>
            )}

            {lastGroupId !== null && (
              <div className="space-y-2 border-t border-white/10 pt-4">
                <input
                  value={reverseReason}
                  onChange={(e) => setReverseReason(e.target.value)}
                  placeholder={t("reverseReason")}
                  data-testid="scanner-reverse-reason"
                  className="w-full rounded-xl bg-navy-950/60 px-3 py-2 text-sm ring-1 ring-white/10"
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
                  className="w-full rounded-xl bg-white/10 py-2 text-sm font-semibold text-danger-ink ring-1 ring-white/10 disabled:opacity-40"
                >
                  {t("reverse")}
                </button>
                <p className="text-xs text-white/55">{t("reverseHint")}</p>
              </div>
            )}
          </section>
        )}
      </div>
    </main>
  );
}
