/**
 * Next.js instrumentation hook: runs once when the server process starts.
 * Validates the environment immediately so a misconfigured deployment fails at boot with a
 * clear list of variable NAMES, instead of failing on the first request.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { env } = await import("./server/env");
    env(); // throws EnvValidationError; Next surfaces it and refuses to serve
  }
}
