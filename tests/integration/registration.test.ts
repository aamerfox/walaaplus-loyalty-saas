import { MembershipRole } from "@prisma/client";
import bcrypt from "bcryptjs";
import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { ConflictError, ValidationError } from "@/server/errors";
import { DEFAULT_LOCATION_NAME, registerBusinessOwner } from "@/server/registration/register";
import { registerTestOwner, resetDatabase, TEST_PASSWORD, uniqueEmail } from "../setup/fixtures";

describe("registerBusinessOwner", () => {
  beforeAll(resetDatabase);

  it("creates User, Business, OWNER membership and default Main location together", async () => {
    const email = uniqueEmail("reg");
    const r = await registerTestOwner({ email, businessName: "Café Test" });

    const user = await prisma.user.findUniqueOrThrow({ where: { id: r.userId } });
    expect(user.email).toBe(email);
    expect(user.passwordHash).not.toBe(TEST_PASSWORD);
    expect(await bcrypt.compare(TEST_PASSWORD, user.passwordHash)).toBe(true);

    const business = await prisma.business.findUniqueOrThrow({ where: { id: r.businessId } });
    expect(business.name).toBe("Café Test");
    expect(business.currency).toBe("SYP");
    expect(business.defaultLocale).toBe("ar");
    expect(business.timezone).toBe("Asia/Damascus");

    const membership = await prisma.businessMembership.findUniqueOrThrow({ where: { id: r.membershipId } });
    expect(membership).toMatchObject({ businessId: r.businessId, userId: r.userId, role: MembershipRole.OWNER, active: true });

    const locations = await prisma.location.findMany({ where: { businessId: r.businessId } });
    expect(locations).toHaveLength(1);
    expect(locations[0]).toMatchObject({ id: r.locationId, name: DEFAULT_LOCATION_NAME, isDefault: true, active: true });
  });

  it("writes audit rows for user, business, membership and location inside the same transaction", async () => {
    const r = await registerTestOwner();
    const audits = await prisma.auditLog.findMany({ where: { businessId: r.businessId }, orderBy: { createdAt: "asc" } });
    expect(audits.map((a) => a.action)).toEqual([
      "user.registered",
      "business.created",
      "membership.created",
      "location.created",
    ]);
    expect(audits.every((a) => a.actorUserId === r.userId)).toBe(true);
  });

  it("normalises the email to lower case and trims", async () => {
    const raw = `  ${uniqueEmail("Mixed").toUpperCase()}  `;
    const r = await registerTestOwner({ email: raw });
    const user = await prisma.user.findUniqueOrThrow({ where: { id: r.userId } });
    expect(user.email).toBe(raw.trim().toLowerCase());
  });

  it("rejects a duplicate email with ConflictError and creates nothing else", async () => {
    const email = uniqueEmail("dup");
    await registerTestOwner({ email });
    const before = await Promise.all([prisma.business.count(), prisma.location.count(), prisma.businessMembership.count()]);

    await expect(registerTestOwner({ email })).rejects.toBeInstanceOf(ConflictError);

    const after = await Promise.all([prisma.business.count(), prisma.location.count(), prisma.businessMembership.count()]);
    expect(after).toEqual(before);
  });

  it("rejects invalid input before touching the database", async () => {
    const before = await prisma.user.count();
    await expect(
      registerBusinessOwner({ email: "not-an-email", password: "short", firstName: "", businessName: "x" }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(registerTestOwner({ timezone: "Mars/Olympus" })).rejects.toBeInstanceOf(ValidationError);
    expect(await prisma.user.count()).toBe(before);
  });
});
