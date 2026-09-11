import NextAuth from "next-auth";
import type { NextRequest } from "next/server";
import { getAuthOptions } from "@/server/auth/options";

/** Options are resolved per request so the module evaluates without a runtime secret at build. */
type Ctx = { params: Promise<{ nextauth: string[] }> };

async function handler(req: NextRequest, ctx: Ctx) {
  return NextAuth(getAuthOptions())(req, ctx);
}

export { handler as GET, handler as POST };
