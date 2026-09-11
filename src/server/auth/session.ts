import { getServerSession } from "next-auth";
import { UnauthorizedError } from "../errors";
import { getAuthOptions } from "./options";

/** Current user id from the session, or null. Never trust anything else in the token. */
export async function getCurrentUserId(): Promise<string | null> {
  const session = await getServerSession(getAuthOptions());
  return session?.user?.id ?? null;
}

/** Guard for server code paths that require a signed-in merchant user. */
export async function requireUserId(): Promise<string> {
  const id = await getCurrentUserId();
  if (!id) throw new UnauthorizedError();
  return id;
}
