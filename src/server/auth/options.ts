import bcrypt from "bcryptjs";
import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import { z } from "zod";
import { prisma } from "../db";
import { env } from "../env";
import { clientIpFromHeaderRecord } from "../http";
import { clearSignInLimit, consumeSignInLimit } from "../security/rate-limit";

const credentialsSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email()),
  password: z.string().min(1).max(200),
});


let cached: NextAuthOptions | undefined;

/**
 * NextAuth configuration, built lazily on first use so that `next build` can evaluate route
 * modules without a runtime secret present. At runtime `env()` enforces every requirement.
 *
 * The JWT carries ONLY the user id. Roles and permissions are never embedded in the session:
 * they are resolved from BusinessMembership on every request (src/server/tenant/context.ts),
 * so a revoked or demoted user loses access immediately.
 *
 * `secret` comes from the validated environment. There is no fallback, by design.
 */
export function getAuthOptions(): NextAuthOptions {
  if (cached) return cached;
  cached = {
    providers: [
      CredentialsProvider({
        name: "Credentials",
        credentials: {
          email: { label: "Email", type: "email" },
          password: { label: "Password", type: "password" },
        },
        async authorize(raw, req) {
          const parsed = credentialsSchema.safeParse(raw);
          if (!parsed.success) return null;

          // Rate limit BEFORE the database lookup and before bcrypt, so a flood of guesses
          // cannot be turned into a flood of password hashes. Both the identifier window and
          // the client-address window are counted; either one can refuse. The address is null
          // unless a trusted proxy supplied it, so a forged header cannot mint fresh windows —
          // the identifier window still applies either way.
          const ip = clientIpFromHeaderRecord(req?.headers);
          const limit = await consumeSignInLimit(parsed.data.email, ip);
          if (!limit.allowed) return null;

          const user = await prisma.user.findUnique({
            where: { email: parsed.data.email },
            select: { id: true, email: true, firstName: true, lastName: true, passwordHash: true, active: true },
          });
          if (!user || !user.active) return null;

          const ok = await bcrypt.compare(parsed.data.password, user.passwordHash);
          if (!ok) return null;

          // A successful sign-in forgets the identifier's window, so a legitimate user who
          // mistyped a few times is not locked out by their own success. The address window
          // stays, so one host cannot mint unlimited attempts by interleaving valid sign-ins.
          await clearSignInLimit(parsed.data.email);

          return {
            id: user.id,
            email: user.email,
            name: [user.firstName, user.lastName].filter(Boolean).join(" ") || null,
          };
        },
      }),
    ],
    session: { strategy: "jwt", maxAge: 24 * 60 * 60 },
    callbacks: {
      async jwt({ token, user }) {
        if (user) token.sub = user.id;
        return token;
      },
      async session({ session, token }) {
        if (session.user && token.sub) session.user.id = token.sub;
        return session;
      },
    },
    pages: { signIn: "/auth/login", error: "/auth/login" },
    secret: env().NEXTAUTH_SECRET,
  };
  return cached;
}
