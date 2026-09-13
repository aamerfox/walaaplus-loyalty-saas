import { describe, expect, it } from "vitest";
import { parseDefinition, readDefinition, toProfileWhere } from "@/server/segments/definition";

/**
 * What a segment definition may say, and exactly what combining conditions means.
 *
 * The validation half of this file is the security half: a definition arrives from a browser, and
 * the only reason it is safe to store one and evaluate it months later is that every field and
 * every operator is on an allowlist. An unknown field is refused, not ignored — a definition that
 * silently dropped a condition would match MORE people than the merchant described, which is the
 * one wrong direction for a rule that a campaign will later act on.
 *
 * The semantics half is the surprising one, and it is pinned here because a sentence in a document
 * cannot be run: in an `all` segment every CARD-scoped condition must be satisfied by the SAME
 * card.
 */

const BUSINESS = "biz_1";

const base = { version: 1 as const, match: "all" as const };

describe("a definition is an allowlist, not a query", () => {
  it("accepts every documented field", () => {
    const definition = parseDefinition({
      ...base,
      conditions: [
        { field: "program", templateId: "t1" },
        { field: "cardType", cardType: "POINTS" },
        { field: "programVersion", templateId: "t1", versionNumber: 2 },
        { field: "stampBalance", range: { min: 1, max: 9 } },
        { field: "pointBalance", range: { min: 100 } },
        { field: "rewardBalance", range: { max: 0 } },
        { field: "source", name: "Instagram" },
        { field: "servedAtLocation", locationId: "loc1" },
        { field: "joinedAt", dateRange: { after: "2026-01-01" } },
        { field: "lastActivityAt", dateRange: { before: "2026-03-01" } },
      ],
    });
    expect(definition.conditions).toHaveLength(10);
  });

  it("refuses an unknown field, an unknown key, and an unknown operator", () => {
    expect(() => parseDefinition({ ...base, conditions: [{ field: "email", value: "a@b.c" }] })).toThrow(/Invalid segment/);
    // A strict object: an extra key is a refusal, not a field that happens to be ignored.
    expect(() => parseDefinition({ ...base, conditions: [{ field: "program", templateId: "t1", sql: "1=1" }] })).toThrow();
    expect(() => parseDefinition({ ...base, conditions: [{ field: "stampBalance", range: { like: "%" } }] })).toThrow();
    expect(() => parseDefinition({ ...base, match: "some", conditions: [{ field: "cardType", cardType: "STAMP" }] })).toThrow();
    // A card type the product does not have.
    expect(() => parseDefinition({ ...base, conditions: [{ field: "cardType", cardType: "CASHBACK" }] })).toThrow();
  });

  it("refuses an empty definition, an unbounded range and a backwards one", () => {
    expect(() => parseDefinition({ ...base, conditions: [] })).toThrow();
    expect(() => parseDefinition({ ...base, conditions: [{ field: "stampBalance", range: {} }] })).toThrow();
    expect(() => parseDefinition({ ...base, conditions: [{ field: "stampBalance", range: { min: 9, max: 1 } }] })).toThrow();
    expect(() => parseDefinition({ ...base, conditions: [{ field: "joinedAt", dateRange: {} }] })).toThrow();
    expect(() => parseDefinition({ ...base, conditions: [{ field: "joinedAt", dateRange: { after: "01/01/2026" } }] })).toThrow();
  });

  it("refuses a definition written in a version it does not understand", () => {
    expect(() => parseDefinition({ version: 2, match: "all", conditions: [{ field: "cardType", cardType: "STAMP" }] })).toThrow();
    // And reading a stored one that cannot be parsed reports null rather than "everybody".
    expect(readDefinition({ version: 99 })).toBeNull();
    expect(readDefinition(null)).toBeNull();
  });
});

describe("combining conditions means one thing, and it is written down", () => {
  it("requires ONE card to satisfy every card condition under `all`", () => {
    const where = toProfileWhere(
      parseDefinition({
        ...base,
        conditions: [
          { field: "program", templateId: "coffee" },
          { field: "stampBalance", range: { min: 5 } },
        ],
      }),
      BUSINESS,
    );

    /*
     * The decision, visible in the shape: ONE `some` holding an `AND`. The other reading — two
     * separate `some` clauses — would match a customer whose coffee card is empty and whose five
     * stamps are on a different programme, and would send them an offer they cannot use.
     */
    expect(where.cards).toEqual({
      some: { businessId: BUSINESS, AND: [{ templateId: "coffee" }, { stampBalance: { gte: 5 } }] },
    });
    expect(where.businessId).toBe(BUSINESS);
  });

  it("puts profile-scoped conditions on the profile, not on a card", () => {
    const where = toProfileWhere(
      parseDefinition({ ...base, conditions: [{ field: "joinedAt", dateRange: { after: "2026-01-01" } }] }),
      BUSINESS,
    );
    expect(where.cards).toBeUndefined();
    expect(where.AND).toEqual([{ firstSeenAt: { gte: new Date("2026-01-01T00:00:00.000Z") } }]);
  });

  it("is an OR across card conditions and profile conditions alike under `any`", () => {
    const where = toProfileWhere(
      parseDefinition({
        version: 1,
        match: "any",
        conditions: [
          { field: "cardType", cardType: "POINTS" },
          { field: "joinedAt", dateRange: { after: "2026-01-01" } },
        ],
      }),
      BUSINESS,
    );
    expect(where.OR).toEqual([
      { firstSeenAt: { gte: new Date("2026-01-01T00:00:00.000Z") } },
      { cards: { some: { businessId: BUSINESS, OR: [{ template: { cardType: "POINTS" } }] } } },
    ]);
  });

  it("scopes every nested clause by business, so a foreign id selects nothing", () => {
    const where = toProfileWhere(
      parseDefinition({
        ...base,
        conditions: [
          { field: "source", name: "Instagram" },
          { field: "servedAtLocation", locationId: "someone-elses-branch" },
        ],
      }),
      BUSINESS,
    );
    const clauses = JSON.stringify(where);
    // The tenant appears on the profile, on the card `some`, on the source's template, and on the
    // operation. Belt and braces: the service also verifies ownership before a definition is saved.
    expect(clauses.match(new RegExp(BUSINESS, "g"))?.length).toBeGreaterThanOrEqual(4);
  });

  it("treats a date range as inclusive of the last day named", () => {
    const where = toProfileWhere(
      parseDefinition({ ...base, conditions: [{ field: "lastActivityAt", dateRange: { before: "2026-03-07" } }] }),
      BUSINESS,
    );
    // Exclusive at the NEXT midnight, so the whole of the 7th is inside the range.
    expect(where.cards).toEqual({
      some: { businessId: BUSINESS, AND: [{ lastActivityAt: { lt: new Date("2026-03-08T00:00:00.000Z") } }] },
    });
  });
});
