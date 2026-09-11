/**
 * Remediation item 7 — UTM link identity.
 *
 * Boomerangme-style distribution creates MANY links per template; two of them often share a
 * utmSource (two Instagram campaigns, two table QR codes tagged "in-store"). The unique key is the
 * link's NAME within its template; publicToken (what the QR/URL carries) stays globally unique.
 */
import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { createBusinessWithCard, resetDatabase, type CardFixture } from "../setup/fixtures";

const token = () => randomBytes(16).toString("base64url");

describe("UtmSourceLink uniqueness", () => {
  let fx: CardFixture;
  let other: CardFixture;

  beforeAll(async () => {
    await resetDatabase();
    fx = await createBusinessWithCard();
    other = await createBusinessWithCard();
  });

  it("allows two links on one template with the SAME utmSource and different names", async () => {
    const a = await prisma.utmSourceLink.create({
      data: { templateId: fx.templateId, name: "Instagram — Ramadan", utmSource: "instagram", publicToken: token() },
    });
    const b = await prisma.utmSourceLink.create({
      data: { templateId: fx.templateId, name: "Instagram — Eid", utmSource: "instagram", publicToken: token() },
    });
    expect(a.utmSource).toBe(b.utmSource);
    expect(await prisma.utmSourceLink.count({ where: { templateId: fx.templateId, utmSource: "instagram" } })).toBe(2);
  });

  it("refuses a second link with the same name on the same template", async () => {
    await expect(
      prisma.utmSourceLink.create({
        data: { templateId: fx.templateId, name: "Instagram — Ramadan", utmSource: "facebook", publicToken: token() },
      }),
    ).rejects.toThrow(/unique|UtmSourceLink_templateId_name_key/i);
  });

  it("allows the same name on a different template (names are scoped per template)", async () => {
    const link = await prisma.utmSourceLink.create({
      data: { templateId: other.templateId, name: "Instagram — Ramadan", utmSource: "instagram", publicToken: token() },
    });
    expect(link.templateId).toBe(other.templateId);
  });

  it("keeps publicToken globally unique", async () => {
    const shared = token();
    await prisma.utmSourceLink.create({ data: { templateId: fx.templateId, name: "Table 1", utmSource: "in-store", publicToken: shared } });
    await expect(
      prisma.utmSourceLink.create({ data: { templateId: other.templateId, name: "Table 1", utmSource: "in-store", publicToken: shared } }),
    ).rejects.toThrow(/unique|UtmSourceLink_publicToken_key/i);
  });

  it("the database has exactly the intended unique indexes on UtmSourceLink", async () => {
    const rows = await prisma.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes WHERE tablename = 'UtmSourceLink' AND indexdef LIKE 'CREATE UNIQUE INDEX%' ORDER BY indexname`;
    expect(rows.map((r) => r.indexname)).toEqual([
      "UtmSourceLink_pkey",
      "UtmSourceLink_publicToken_key",
      "UtmSourceLink_templateId_name_key",
    ]);
  });
});
