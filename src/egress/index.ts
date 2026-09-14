import { gatewaySecretAvailable } from "./auth";
import { startEgressServer, type DispatchObservation } from "./server";

/**
 * WalaaPlus webhook egress gateway — a SEPARATE process from web and from the worker.
 *
 *   npm run egress        production-style start (the built bundle)
 *   npm run egress:dev    restart on change
 *
 * It holds no database credential, no encryption key and no signing secret, and it is the only
 * service attached to a routable Docker network. See `docs/WEBHOOK-EGRESS-TOPOLOGY.md`.
 *
 * ## Why an unset secret does not stop it
 *
 * A missing `WEBHOOK_GATEWAY_SECRET` means this deployment has not turned webhooks on. The right
 * response to that is to answer `SECRET_UNAVAILABLE` to every dispatch — which is fail-closed,
 * because nothing is sent — and not to crash-loop a container on a one-vCPU box shared with other
 * people's services. So it starts either way, says which state it is in once, and refuses.
 *
 * ## What is logged
 *
 * A startup line, a shutdown line, and one line per dispatch carrying a classification and a
 * duration. **No URL, no path, no query token, no header, no body, no response, no error string and
 * no identifier of any kind** — there is nothing in a line here that names a business, a delivery,
 * an event or a destination. `tests/unit/webhook-egress-boundary.test.ts` holds that shape.
 */

const DEFAULT_PORT = 8082;

function log(msg: string, extra: Record<string, unknown> = {}): void {
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), service: "egress", msg, ...extra }) + "\n");
}

function readPort(): number {
  const raw = process.env.WEBHOOK_EGRESS_PORT;
  if (raw === undefined || raw.trim() === "") return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    process.stderr.write("egress: WEBHOOK_EGRESS_PORT is not a valid port\n");
    process.exit(2);
  }
  return port;
}

async function main(): Promise<void> {
  const port = readPort();

  const server = await startEgressServer({
    port,
    onDispatch: (observation: DispatchObservation) => {
      log("dispatch", {
        // One of these is null. Neither carries an identifier, an address or a message.
        outcome: observation.result?.outcome ?? null,
        errorClass: observation.result?.errorClass ?? null,
        httpStatus: observation.result?.httpStatus ?? null,
        refused: observation.refusal,
        ms: observation.durationMs,
      });
    },
  });

  /*
   * Reported once, by name, with no part of any value. `false` is a supported state: the service
   * runs and refuses every dispatch, and nothing else in the product is affected.
   */
  log("listening", { port: server.port, secretConfigured: gatewaySecretAvailable() });

  const shutdown = async (signal: string) => {
    log("shutting down", { signal });
    try {
      await server.close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  // The message is not printed: a startup failure's text can carry a bind address or a path.
  process.stderr.write(`egress: failed to start (${(err as Error)?.name ?? "Error"})\n`);
  process.exit(1);
});
