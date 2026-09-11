/**
 * Development seed. Creates ONE owner + business through the real registration service so the
 * seed exercises the same atomic path as production sign-up.
 *
 *   SEED_OWNER_EMAIL=owner@example.test SEED_OWNER_PASSWORD=<choose> npm run db:seed
 *
 * Refuses to run when NODE_ENV=production. No password literal lives in this file: if
 * SEED_OWNER_PASSWORD is unset a random one is generated and printed ONCE to the terminal.
 */
import { randomBytes } from "node:crypto";
import { config as loadDotenv } from "dotenv";

loadDotenv({ quiet: true });

async function main(): Promise<void> {
  const { env } = await import("../src/server/env");
  const { prisma } = await import("../src/server/db");
  const { registerBusinessOwner } = await import("../src/server/registration/register");

  if (env().NODE_ENV === "production") {
    throw new Error("Refusing to seed a production environment.");
  }

  const email = (process.env.SEED_OWNER_EMAIL ?? "owner@example.test").toLowerCase();
  const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (existing) {
    console.log(`seed: ${email} already exists, nothing to do`);
    return;
  }

  const generated = !process.env.SEED_OWNER_PASSWORD;
  const password = process.env.SEED_OWNER_PASSWORD ?? randomBytes(12).toString("base64url");

  const r = await registerBusinessOwner({
    email,
    password,
    firstName: "Seed",
    lastName: "Owner",
    businessName: "Walaa Cafe (seed)",
    locale: "ar",
    currency: "SYP",
    timezone: "Asia/Damascus",
  });

  console.log(`seed: created business ${r.businessId} with owner ${email}`);
  if (generated) console.log(`seed: generated password (shown once): ${password}`);
}

main()
  .catch((e) => {
    console.error("seed failed:", e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(async () => {
    const { prisma } = await import("../src/server/db");
    await prisma.$disconnect();
  });
