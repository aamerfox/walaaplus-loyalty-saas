import { lookup as dnsLookup } from "node:dns";
import { isIP } from "node:net";

/**
 * Is this URL somewhere the server may be told to send a request?
 *
 * A merchant-supplied URL is the classic server-side request forgery: the product makes a request,
 * from inside the network, to an address a stranger chose. Everything here exists because one of
 * those choices is `http://169.254.169.254/latest/meta-data/iam/security-credentials/`.
 *
 * ## The check that actually matters is the second one
 *
 * Validating the hostname when the owner saves it proves nothing later. The same name can resolve to
 * a public address at save time and to `10.0.0.1` a second afterwards — **DNS rebinding**, and it is
 * not exotic; it is a TTL of zero and a cooperative resolver.
 *
 * So there are two checks and the important one is at connection time:
 *
 *   `assertSafeWebhookUrl`      the shape of the URL. Runs when the owner saves it, and again
 *                               before every request.
 *   `safeLookup`                resolves the hostname and returns ONLY an address that has just
 *                               passed validation. Handed to Node as the agent's `lookup`, so the
 *                               socket connects to the address that was checked, in the same breath.
 *                               There is no window between the two.
 *
 * A design that resolved, validated, and then connected by hostname would re-resolve inside the
 * agent and could get a different answer. The `lookup` hook is what closes that.
 *
 * TLS SNI and the `Host` header stay the hostname, so a receiver behind virtual hosting still works.
 *
 * See `docs/INTEGRATIONS-CAPABILITY-MATRIX.md` §7a.
 */

/** Raised for anything the product will not send to. Never retried — see the matrix's retry table. */
export class UnsafeWebhookAddressError extends Error {
  /** A short, non-identifying reason. Safe to show an owner; never contains a resolved address. */
  readonly reason: string;
  constructor(reason: string) {
    super(`This address cannot be used: ${reason}`);
    this.name = "UnsafeWebhookAddressError";
    this.reason = reason;
  }
}

/** A merchant's URL is not a novel; a long one is usually a mistake or an attempt. */
export const MAX_URL_LENGTH = 2000;

/**
 * The only port a webhook destination may use, at either end of its life.
 *
 * It lives HERE, in the module both ends already share, because it is enforced twice and the two
 * enforcements must not be able to disagree:
 *
 *   - `destinations.ts` refuses any other port when the OWNER SAVES, so the refusal arrives with
 *     the form rather than in an attempt history days later;
 *   - `src/egress/contract.ts` refuses it again when the GATEWAY DISPATCHES, which is what still
 *     covers a row written before this rule existed, restored from a backup, or inserted directly.
 *
 * `assertSafeWebhookUrl` below deliberately does NOT apply it. That function answers "is this
 * address safe to request at all", which is a different question from "is this a port this product
 * offers" — and the gateway needs the port as a separate, injectable decision so a test can reach a
 * receiver on an ephemeral port without softening any address rule.
 */
export const WEBHOOK_PORT = 443;

/**
 * Host suffixes that never reach a customer's server.
 *
 * `.local` is mDNS, `.internal` and `.intranet` are the conventional private zones, and
 * `localhost` in any position is the loopback under another name.
 */
const FORBIDDEN_SUFFIXES = [".local", ".internal", ".intranet", ".localhost", ".home.arpa"];

function isForbiddenName(host: string): string | null {
  if (host === "localhost") return "localhost is not a destination";
  // A single label — `intranet`, `router` — is a name only this network can resolve.
  if (!host.includes(".")) return "the host must be a fully qualified domain name";
  for (const suffix of FORBIDDEN_SUFFIXES) {
    if (host.endsWith(suffix)) return "the host is a private or loopback name";
  }
  return null;
}

/**
 * Is this IPv4 address one the product may connect to?
 *
 * The list is the reserved space, and it is deliberately exhaustive rather than "not 10/8 and not
 * 192.168/16". `100.64/10` (carrier NAT) and `192.0.0/24` are the two people forget.
 */
function ipv4Problem(address: string): string | null {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return "the address is malformed";
  }
  const [a, b] = parts;
  if (a === 0) return "the address is unspecified";
  if (a === 10) return "the address is private";
  if (a === 127) return "the address is loopback";
  if (a === 100 && b >= 64 && b <= 127) return "the address is carrier-grade NAT";
  if (a === 169 && b === 254) return "the address is link-local";
  if (a === 172 && b >= 16 && b <= 31) return "the address is private";
  if (a === 192 && b === 0) return "the address is reserved";
  if (a === 192 && b === 168) return "the address is private";
  if (a === 198 && (b === 18 || b === 19)) return "the address is reserved for benchmarking";
  if (a === 198 && b === 51) return "the address is reserved for documentation";
  if (a === 203 && b === 0) return "the address is reserved for documentation";
  if (a >= 224) return "the address is multicast, reserved or broadcast";
  return null;
}

function ipv6Problem(address: string): string | null {
  const lower = address.toLowerCase().split("%")[0];
  if (lower === "::" ) return "the address is unspecified";
  if (lower === "::1") return "the address is loopback";
  // IPv4-mapped and IPv4-compatible: `::ffff:10.0.0.1` is `10.0.0.1` wearing a hat.
  const mapped = /^::(ffff:)?(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return ipv4Problem(mapped[2]) ?? "the address is an IPv4-mapped address";
  if (/^f[cd]/.test(lower)) return "the address is unique-local";
  if (/^fe[89ab]/.test(lower)) return "the address is link-local";
  if (/^ff/.test(lower)) return "the address is multicast";
  if (lower.startsWith("2001:db8")) return "the address is reserved for documentation";
  if (lower.startsWith("64:ff9b")) return "the address is a NAT64 prefix";
  return null;
}

/** Public, routable, and not a way back into this network? */
export function addressProblem(address: string): string | null {
  const family = isIP(address);
  if (family === 4) return ipv4Problem(address);
  if (family === 6) return ipv6Problem(address);
  return "the address is malformed";
}

export interface SafeWebhookUrl {
  /** Normalised, with the fragment removed. This is what gets encrypted and what gets requested. */
  href: string;
  /** Lower-cased hostname. Plaintext on the destination row; never a credential. */
  host: string;
  port: number;
  pathWithQuery: string;
}

/**
 * The shape rules. Run when the owner saves, and again immediately before every request.
 *
 * Re-running it before each request is not belt and braces: a destination's ciphertext is decrypted
 * at delivery time, and a value that somehow changed underneath — a restored backup, a future
 * rotation bug — is checked again rather than trusted because it was checked once.
 */
export function assertSafeWebhookUrl(raw: string): SafeWebhookUrl {
  if (typeof raw !== "string" || raw.length === 0) throw new UnsafeWebhookAddressError("no address was given");
  if (raw.length > MAX_URL_LENGTH) throw new UnsafeWebhookAddressError("the address is too long");
  if (/[\s\u0000-\u001f\u007f]/.test(raw)) {
    // A newline in a URL is a request-splitting attempt, not a typo.
    throw new UnsafeWebhookAddressError("the address contains whitespace or a control character");
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeWebhookAddressError("the address is not a valid URL");
  }

  if (url.protocol !== "https:") {
    // Plaintext would expose the signed body and the URL's own path token to the network.
    throw new UnsafeWebhookAddressError("only https:// is accepted");
  }
  if (url.username !== "" || url.password !== "") {
    // Credentials in a URL end up in logs, in error strings and in screenshots.
    throw new UnsafeWebhookAddressError("the address must not contain a username or password");
  }

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (isIP(host) !== 0) {
    // A literal bypasses the DNS policy question entirely, so it is refused before it is asked.
    throw new UnsafeWebhookAddressError("the host must be a name, not an IP address");
  }
  const nameProblem = isForbiddenName(host);
  if (nameProblem) throw new UnsafeWebhookAddressError(nameProblem);

  const port = url.port === "" ? 443 : Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new UnsafeWebhookAddressError("the port is not valid");
  }

  // The fragment never reaches a server; carrying one would only ever be a copy-paste accident.
  url.hash = "";
  return { href: url.toString(), host, port, pathWithQuery: `${url.pathname}${url.search}` };
}

/** What `safeLookup` hands back, and what the socket then connects to. */
export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/**
 * Whether one resolved address may be connected to. Returns a reason, or null for "yes".
 *
 * Injectable for ONE reason, and it is worth being explicit about: the local HTTPS receiver the
 * delivery tests talk to is on loopback, and `addressProblem` refuses loopback — correctly, and
 * unconditionally, because that is the rule production needs. Rather than soften the rule, or point
 * the tests at something outside this machine, the policy is a parameter whose default IS the rule.
 *
 * No production caller passes one. `tests/unit/webhook-boundary.test.ts` asserts that the delivery
 * runner and the worker job never do, so the seam cannot quietly become a way round the check.
 */
export type AddressPolicy = (address: string) => string | null;

/** Node's `dns.lookup` shape, injectable so a test can drive it without a resolver. */
export type LookupFn = (
  hostname: string,
  options: { all: true },
  callback: (err: NodeJS.ErrnoException | null, addresses: { address: string; family: number }[]) => void,
) => void;

/**
 * Resolve a hostname and return only an address that is safe **right now**.
 *
 * Every address the resolver returns is checked, not just the first: a name that answers with one
 * public address and one `10.0.0.1` is an attempt, and picking the public one and moving on would
 * mean the next resolution — inside the agent, or on a retry — could pick the other. If any answer
 * is unsafe, the whole resolution is refused.
 */
export async function resolveSafeAddress(
  hostname: string,
  lookup: LookupFn = dnsLookup as LookupFn,
  policy: AddressPolicy = addressProblem,
): Promise<ResolvedAddress> {
  const answers = await new Promise<{ address: string; family: number }[]>((resolve, reject) => {
    lookup(hostname, { all: true }, (err, addresses) => {
      if (err) {
        reject(new UnsafeWebhookAddressError("the host could not be resolved"));
        return;
      }
      resolve(addresses ?? []);
    });
  });

  if (answers.length === 0) throw new UnsafeWebhookAddressError("the host resolved to no addresses");

  for (const answer of answers) {
    const problem = policy(answer.address);
    if (problem) throw new UnsafeWebhookAddressError(problem);
  }

  const chosen = answers[0];
  return { address: chosen.address, family: chosen.family === 6 ? 6 : 4 };
}

/**
 * A `lookup` for Node's HTTPS agent that can only ever return a validated address.
 *
 * This is the whole DNS-rebinding defence in one function. The agent does not resolve the hostname
 * itself and then connect; it asks this, and this answers with an address it has just checked. The
 * check and the connection are the same decision, so there is no window between them.
 *
 * `onResolved` reports what was chosen so the caller can record a refusal reason without the address
 * itself ever reaching a log or a column.
 */
export function makeGuardedLookup(
  inner: LookupFn = dnsLookup as LookupFn,
  onResolved?: (result: ResolvedAddress) => void,
  policy: AddressPolicy = addressProblem,
) {
  return function guardedLookup(
    hostname: string,
    options: { all?: boolean } | undefined,
    callback: (
      err: NodeJS.ErrnoException | null,
      address?: string | ResolvedAddress[],
      family?: number,
    ) => void,
  ): void {
    resolveSafeAddress(hostname, inner, policy).then(
      (resolved) => {
        onResolved?.(resolved);
        /*
         * Node calls a custom `lookup` with `{ all: true }` whenever Happy Eyeballs is on — which it
         * is by default from Node 20 — and then expects an ARRAY back. Answering with a bare string
         * in that case produces `ERR_INVALID_IP_ADDRESS: undefined`, which looks like a DNS problem
         * and is not one. Both shapes are honoured, and only the one validated address is ever
         * offered either way.
         */
        if (options?.all) callback(null, [resolved]);
        else callback(null, resolved.address, resolved.family);
      },
      (err: unknown) => {
        // Surfaced as a lookup failure so the request never starts. The caller classifies it as
        // UNSAFE_ADDRESS from the error it kept, never from a socket error string.
        callback(err instanceof Error ? (err as NodeJS.ErrnoException) : new Error("lookup failed"));
      },
    );
  };
}
