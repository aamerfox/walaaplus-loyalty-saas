import { createServer, type Server } from "node:https";
import type { IncomingHttpHeaders } from "node:http";
import { X509Certificate, createPrivateKey } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A local HTTPS receiver, for the webhook delivery tests.
 *
 * **Nothing outside this machine is contacted.** The certificate is generated here, the port is
 * whatever the OS hands out, and the server is stopped when the suite ends. There is no real
 * endpoint, no provider, no staging service and no network path beyond loopback.
 *
 * The certificate names the hostname the tests use, and the transport is given it as a trusted CA
 * for those calls only — so TLS verification is genuinely exercised rather than switched off. A test
 * that disabled certificate checking would be a test that could not tell a TLS failure from a
 * success, which is one of the outcomes being asserted.
 */

export interface ReceivedRequest {
  path: string;
  method: string;
  headers: IncomingHttpHeaders;
  body: string;
}

export interface Receiver {
  port: number;
  /** What the fake resolver answers with, so the socket reaches this server. */
  address: string;
  /** The self-signed certificate, handed to the transport as a trusted CA for these tests. */
  ca: string;
  requests: ReceivedRequest[];
  reset(): void;
  close(): Promise<void>;
}

/** The hostname the certificate is issued for. Matches the URL the tests configure. */
export const RECEIVER_HOST = "hooks.test.example.com";

/** Repeated to fill the `/big` response. Distinctive enough to grep a database dump for. */
export const OVERSIZED_MARKER = "RECEIVER-BODY-MUST-NEVER-ESCAPE-";

/**
 * A self-signed certificate for `RECEIVER_HOST`.
 *
 * Generated with OpenSSL, which is present wherever this suite runs (the gate already shells out to
 * it). Node has no certificate-authoring API, and pinning a fixture certificate in the repository
 * would mean committing a private key — which this project does not do, even a throwaway one.
 */
function selfSigned(): { key: string; cert: string } {
  const dir = mkdtempSync(join(tmpdir(), "walaaplus-receiver-"));
  try {
    const keyPath = join(dir, "key.pem");
    const certPath = join(dir, "cert.pem");
    const confPath = join(dir, "openssl.cnf");
    writeFileSync(
      confPath,
      [
        "[req]",
        "distinguished_name = dn",
        "x509_extensions = ext",
        "prompt = no",
        "[dn]",
        `CN = ${RECEIVER_HOST}`,
        "[ext]",
        "basicConstraints = critical,CA:TRUE",
        `subjectAltName = DNS:${RECEIVER_HOST}`,
      ].join("\n"),
    );
    execFileSync(
      "openssl",
      [
        "req", "-x509", "-newkey", "rsa:2048", "-nodes",
        "-keyout", keyPath, "-out", certPath,
        "-days", "1", "-config", confPath,
      ],
      { stdio: "ignore" },
    );
    return { key: readFileSync(keyPath, "utf8"), cert: readFileSync(certPath, "utf8") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Start the receiver.
 *
 * Routes, each one an outcome the delivery code has to classify:
 *
 *   /hook          200, the happy path
 *   /status/:code  whatever the test asks for
 *   /redirect      302 to the cloud metadata address — the SSRF bypass the transport must refuse
 *   /hang          never answers, so the request times out
 *   /big           200 with a body far past the read cap, carrying a marker string, so a test can
 *                  assert the marker reaches nothing — not the gateway's answer, not a column
 */
export async function startReceiver(): Promise<Receiver> {
  const { key, cert } = selfSigned();
  const requests: ReceivedRequest[] = [];
  const hanging: { destroy(): void }[] = [];

  const server: Server = createServer({ key, cert }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const path = req.url ?? "/";
      requests.push({
        path,
        method: req.method ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });

      if (path === "/hang") {
        // Answer nothing. The transport's own timeout is what ends this.
        hanging.push(res);
        return;
      }
      if (path === "/redirect") {
        res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
        res.end();
        return;
      }
      if (path === "/big") {
        // Well past MAX_RESPONSE_BYTES. The marker is what a test looks for afterwards: if the
        // gateway ever started returning or recording a response body, this string is how it
        // would show up.
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, leak: OVERSIZED_MARKER.repeat(400) }));
        return;
      }
      const status = /^\/status\/(\d{3})$/.exec(path);
      res.writeHead(status ? Number(status[1]) : 200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;

  // Sanity: the certificate really is for the hostname the tests use, so TLS is being exercised.
  const parsed = new X509Certificate(cert);
  if (!parsed.checkHost(RECEIVER_HOST)) throw new Error("receiver certificate does not name the test host");
  createPrivateKey(key);

  return {
    port,
    address: "127.0.0.1",
    ca: cert,
    requests,
    reset() {
      requests.length = 0;
    },
    async close() {
      for (const res of hanging) res.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
