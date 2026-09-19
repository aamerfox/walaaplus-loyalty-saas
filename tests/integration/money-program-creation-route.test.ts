import { beforeEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ userId: null as string | null }));

vi.mock("@/server/auth/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/auth/session")>();
  const { UnauthorizedError } = await import("@/server/errors");
  return {
    ...actual,
    getCurrentUserId: async () => session.userId,
    requireUserId: async () => {
      if (!session.userId) throw new UnauthorizedError();
      return session.userId;
    },
  };
});

import { POST } from "@/app/api/staff/programs/route";
import { POST as moneyVersion } from "@/app/api/staff/money-version/route";
import { prisma } from "@/server/db";
import { createCafeCashier, createStampCafe, registerTestOwner, resetDatabase } from "../setup/fixtures";

async function call(body: unknown) {
  const response = await POST(new Request("http://localhost/api/staff/programs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe("initial money-program configuration route", () => {
  beforeEach(async () => {
    await resetDatabase();
    session.userId = null;
  });

  it.each(["CASHBACK", "DISCOUNT"] as const)("keeps an initial %s program DRAFT until explicit publish", async (cardType) => {
    const owner = await registerTestOwner();
    session.userId = owner.userId;

    const answer = await call({
      cardType,
      name: `First ${cardType.toLowerCase()}`,
      availableLocations: [owner.locationId],
      tiers: [{ minCumulativeSpendMinor: 0, rateBasisPoints: 500 }],
    });

    expect(answer.status).toBe(201);
    const template = await prisma.programTemplate.findFirstOrThrow({ where: { businessId: owner.businessId } });
    expect(template.cardType).toBe(cardType);
    const version = await prisma.programVersion.findFirstOrThrow({ where: { templateId: template.id } });
    expect(version.status).toBe("DRAFT");
    expect(answer.body.lifecycle).toBe("DRAFT_REQUIRES_EXPLICIT_PUBLISH");

    const emptied = await moneyVersion(new Request("http://localhost/api/staff/money-version", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "updateRateTable", templateId: template.id, tiers: [] }),
    }));
    expect(emptied.status).toBe(200);
    const incomplete = await moneyVersion(new Request("http://localhost/api/staff/money-version", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "publish", templateId: template.id, expectedVersionNumber: version.versionNumber }),
    }));
    expect(incomplete.status).toBe(400);

    const edited = await moneyVersion(new Request("http://localhost/api/staff/money-version", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "updateRateTable", templateId: template.id, tiers: [{ minCumulativeSpendMinor: 0, rateBasisPoints: 750 }] }),
    }));
    expect(edited.status).toBe(200);
    const published = await moneyVersion(new Request("http://localhost/api/staff/money-version", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "publish", templateId: template.id, expectedVersionNumber: version.versionNumber }),
    }));
    expect(published.status).toBe(200);
    expect((await prisma.programVersion.findUniqueOrThrow({ where: { id: version.id } })).status).toBe("ACTIVE");
  });

  it("lets an owner save an incomplete discount draft for later configuration", async () => {
    const owner = await registerTestOwner();
    session.userId = owner.userId;
    const answer = await call({
      cardType: "DISCOUNT",
      name: "Incomplete discount",
      availableLocations: [owner.locationId],
      tiers: [],
    });
    expect(answer.status).toBe(201);
    expect(await prisma.programVersion.count({ where: { template: { businessId: owner.businessId, cardType: "DISCOUNT" }, status: "DRAFT" } })).toBe(1);
  });

  it("does not let a cashier create or configure a money program", async () => {
    const owner = await createStampCafe();
    const cashier = await createCafeCashier(owner);
    session.userId = cashier.userId;
    const answer = await call({
      cardType: "CASHBACK",
      name: "Cashier attempt",
      availableLocations: [owner.locationId],
      tiers: [{ minCumulativeSpendMinor: 0, rateBasisPoints: 500 }],
    });
    expect(answer.status).toBe(403);
    expect(await prisma.programTemplate.count({ where: { businessId: owner.businessId, cardType: { in: ["CASHBACK", "DISCOUNT"] } } })).toBe(0);
  });
});
