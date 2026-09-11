import { beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Proves registration is one transaction: if the LAST step (the location audit row) throws,
 * the User, Business, Membership and Location created before it are all rolled back.
 */
vi.mock("@/server/audit/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/audit/audit")>();
  return {
    ...actual,
    recordAudit: vi.fn(async (db, entry) => {
      if (entry.action === actual.AuditAction.LOCATION_CREATED && entry.metadata && "boom" in (entry.metadata as object)) {
        throw new Error("injected failure after location create");
      }
      if (entry.action === actual.AuditAction.LOCATION_CREATED && process.env.__INJECT_REG_FAILURE === "1") {
        throw new Error("injected failure after location create");
      }
      return actual.recordAudit(db, entry);
    }),
  };
});

import { prisma } from "@/server/db";
import { registerTestOwner, resetDatabase, uniqueEmail } from "../setup/fixtures";

describe("registration atomicity", () => {
  beforeAll(resetDatabase);

  it("rolls back every row when a late step in the transaction fails", async () => {
    const email = uniqueEmail("atomic");
    process.env.__INJECT_REG_FAILURE = "1";
    try {
      await expect(registerTestOwner({ email })).rejects.toThrow("injected failure");
    } finally {
      delete process.env.__INJECT_REG_FAILURE;
    }

    expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
    expect(await prisma.business.count()).toBe(0);
    expect(await prisma.businessMembership.count()).toBe(0);
    expect(await prisma.location.count()).toBe(0);
    expect(await prisma.auditLog.count()).toBe(0);
  });

  it("succeeds normally when nothing is injected", async () => {
    const r = await registerTestOwner();
    expect(await prisma.location.count({ where: { businessId: r.businessId } })).toBe(1);
  });
});
