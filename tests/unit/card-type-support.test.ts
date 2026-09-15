import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CardType } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  assertCounterSupportsCardType,
  assertNeverCardType,
  CARD_TYPE_SUPPORT,
  CardEngine,
  isMonetaryCardType,
  readVersionAvailableLocations,
  versionContractOf,
} from "@/server/program/card-type-support";

/**
 * The guard against the next card type silently inheriting stamp behaviour.
 *
 * ## What went wrong, and why a test is warranted
 *
 * `CardType` held two values from Phase 0 until Phase 4 added `CASHBACK` and `DISCOUNT`. That broke
 * seven separate places, every one the same shape — `if (POINTS) … else STAMP`, or
 * `isPoints ? … : isStamp ? … : undefined`. Three were live defects: a money program could not issue
 * a card at all, a money draft would have been published as a stamp program, and a money program
 * could have its only counter closed without being reported as stranded. None of them failed to
 * compile, because neither shape is exhaustive.
 *
 * `CARD_TYPE_SUPPORT` is a `Record<CardType, …>`, so a fifth value now fails the build. These tests
 * hold the same line at runtime, which matters because a generated Prisma client can be stale and
 * `strict` can be turned off.
 */

describe("every card type is accounted for", () => {
  it("has an entry for each value of the enum, with no extras", () => {
    const declared = Object.values(CardType).sort();
    const supported = Object.keys(CARD_TYPE_SUPPORT).sort();
    expect(supported).toEqual(declared);
  });

  it("names a real engine for every one", () => {
    for (const cardType of Object.values(CardType)) {
      expect(Object.values(CardEngine)).toContain(CARD_TYPE_SUPPORT[cardType].engine);
    }
  });

  it("routes the two money types to the monetary engine and nothing else there", () => {
    expect(isMonetaryCardType(CardType.CASHBACK)).toBe(true);
    expect(isMonetaryCardType(CardType.DISCOUNT)).toBe(true);
    expect(isMonetaryCardType(CardType.STAMP)).toBe(false);
    expect(isMonetaryCardType(CardType.POINTS)).toBe(false);
  });

  it("keeps every money type out of the stamp/points counter, the draft editor and wallet passes", () => {
    // Not because the work is unfinished in a vague sense: each of those is Prompt 2 or later, and
    // the cost of a silent inheritance is a wrong number in front of a customer.
    for (const cardType of Object.values(CardType)) {
      if (!isMonetaryCardType(cardType)) continue;
      expect(CARD_TYPE_SUPPORT[cardType]).toMatchObject({ counterUi: false, draftEditor: false, walletPass: false });
    }
  });

  it("builds a wallet pass for stamp cards only, as every phase so far has", () => {
    const withPasses = Object.values(CardType).filter((t) => CARD_TYPE_SUPPORT[t].walletPass);
    expect(withPasses).toEqual([CardType.STAMP]);
  });
});

describe("refusing a card type the counter cannot serve", () => {
  it("lets the two counter types through", () => {
    expect(() => assertCounterSupportsCardType(CardType.STAMP)).not.toThrow();
    expect(() => assertCounterSupportsCardType(CardType.POINTS)).not.toThrow();
  });

  it("refuses a money card with a sentence about the SCREEN, not about the data", () => {
    /*
     * The wording is asserted deliberately. Before this guard existed a cashback card reaching card
     * lookup was refused with "does not hold valid stamp mechanics" — which reads as a corrupt row
     * and would send somebody hunting for a broken record. Nothing is broken.
     */
    for (const cardType of [CardType.CASHBACK, CardType.DISCOUNT]) {
      expect(() => assertCounterSupportsCardType(cardType)).toThrow(/cashback or discount card/);
      expect(() => assertCounterSupportsCardType(cardType)).not.toThrow(/mechanics/);
    }
  });
});

describe("locations are read through every contract, not two of them", () => {
  const stamp = { kind: "STAMP", contractVersion: 1, stampsRequiredPerReward: 8, rewardName: "قهوة", earnMode: "MANUAL" };
  const points = { kind: "POINTS", contractVersion: 1, earnMode: "MANUAL", countRewardRedemptionAsVisit: false };
  const cashback = { kind: "CASHBACK", contractVersion: 1 };
  const discount = { kind: "DISCOUNT", contractVersion: 1 };

  it("returns null for a version that names no locations, whatever kind it is", () => {
    for (const m of [stamp, points, cashback, discount]) {
      expect(readVersionAvailableLocations(m)).toBeNull();
    }
  });

  it("returns the list for a MONEY version, which the old two-branch ladder dropped", () => {
    /*
     * The regression this exists for. `isPoints ? … : isStamp ? … : undefined` read a money version
     * as "Main only", so `tenant/locations.ts` never reported a money program as stranded and a
     * merchant could close the only counter it ran at.
     */
    expect(readVersionAvailableLocations({ ...cashback, availableLocations: ["loc-a", "loc-b"] })).toEqual(["loc-a", "loc-b"]);
    expect(readVersionAvailableLocations({ ...discount, availableLocations: ["loc-c"] })).toEqual(["loc-c"]);
  });

  it("still returns the list for stamp and points versions", () => {
    expect(readVersionAvailableLocations({ ...stamp, availableLocations: ["loc-a"] })).toEqual(["loc-a"]);
    expect(readVersionAvailableLocations({ ...points, availableLocations: ["loc-b"] })).toEqual(["loc-b"]);
  });

  it("reads a row that parses as no contract at all as Main-only rather than throwing", () => {
    // A list is the wrong place to throw: one corrupt program would empty a merchant's whole picker.
    // The engines refuse such a row loudly when value actually moves.
    expect(readVersionAvailableLocations({ kind: "SOMETHING_ELSE" })).toBeNull();
    expect(readVersionAvailableLocations(null)).toBeNull();
    expect(readVersionAvailableLocations(undefined)).toBeNull();
  });
});

describe("'Main only' and 'nobody can parse this' are told apart", () => {
  /*
   * `readVersionAvailableLocations` returns null for BOTH, which is the right answer for a list.
   * It is the wrong answer for `assertCardWithinMemberScope`, which hands a cashier a capability:
   * there, a row nobody can parse must fail closed rather than be read as the most permissive
   * setting. Consolidating the two-contract ladders briefly lost that distinction, so it is now a
   * named function with a test of its own.
   */
  it("names the contract for every kind this product understands", () => {
    expect(versionContractOf({ kind: "STAMP", contractVersion: 1, stampsRequiredPerReward: 8, rewardName: "قهوة", earnMode: "MANUAL" })).toBe("STAMP");
    expect(versionContractOf({ kind: "POINTS", contractVersion: 1, earnMode: "MANUAL", countRewardRedemptionAsVisit: false })).toBe("POINTS");
    expect(versionContractOf({ kind: "CASHBACK", contractVersion: 1 })).toBe("CASHBACK");
    expect(versionContractOf({ kind: "DISCOUNT", contractVersion: 1 })).toBe("DISCOUNT");
  });

  it("returns null ONLY for a row that parses as no contract", () => {
    expect(versionContractOf({ kind: "GIFT", contractVersion: 1 })).toBeNull();
    expect(versionContractOf({})).toBeNull();
    expect(versionContractOf(null)).toBeNull();
    // A Main-only money version has a contract; it simply lists no locations. The capability check
    // must let this through and refuse the one above.
    expect(versionContractOf({ kind: "CASHBACK", contractVersion: 1 })).not.toBeNull();
    expect(readVersionAvailableLocations({ kind: "CASHBACK", contractVersion: 1 })).toBeNull();
  });
});

describe("the exhaustiveness helper", () => {
  it("throws when a switch falls through to it", () => {
    // Reached only if `strict` is off or a generated client holds a value this build never saw.
    expect(() => assertNeverCardType("GIFT" as never)).toThrow(/Unhandled card type: GIFT/);
  });
});

/**
 * A source-level sweep, kept deliberately narrow.
 *
 * It does not try to find every two-branch conditional in the codebase — that would be a pattern
 * match on style, and it would go stale or cry wolf. It asserts one specific thing: the modules that
 * dispatch on card type or on a mechanics contract go through `card-type-support.ts`, so the next
 * person adding an enum value is told by the compiler rather than by a merchant.
 */
describe("the dispatching modules route through the shared vocabulary", () => {
  const root = join(process.cwd(), "src", "server");
  const read = (p: string) => readFileSync(join(root, p), "utf8");

  const MUST_IMPORT_SUPPORT = [
    // Each of these held a `POINTS or else STAMP` branch or a two-contract mechanics ladder.
    "customers/lookup.ts",
    "customers/counter-enrollment.ts",
    "program/counter.ts",
    "program/programs.ts",
    "program/program-detail.ts",
    "tenant/locations.ts",
  ];

  for (const file of MUST_IMPORT_SUPPORT) {
    it(`${file} imports card-type-support`, () => {
      // Any relative spelling: "./card-type-support" from within program/, "../program/…" elsewhere.
      expect(read(file)).toMatch(/from "\.[^"]*card-type-support"/);
    });
  }

  it("no dispatching module still reads locations through a two-contract ladder", () => {
    for (const file of MUST_IMPORT_SUPPORT) {
      const source = read(file);
      // The exact shape that dropped money versions: a points check, a stamp check, and no third arm.
      expect(source).not.toMatch(/isPointsMechanics\([^)]*\)\s*\n?\s*\?[\s\S]{0,200}isStampMechanics/);
    }
  });
});
