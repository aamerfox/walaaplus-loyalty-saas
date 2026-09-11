import type { DefaultSession } from "next-auth";

/**
 * The session carries ONLY the user id. Roles and permissions are deliberately absent:
 * they are resolved from BusinessMembership on every request (src/server/tenant/context.ts).
 */
declare module "next-auth" {
  interface Session {
    user: { id: string } & DefaultSession["user"];
  }
  interface User {
    id: string;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    sub: string;
  }
}
