import createNextIntlPlugin from 'next-intl/plugin';
 
const withNextIntl = createNextIntlPlugin();
 
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone", // Enables Docker/VPS native hosting

  /*
   * No `images.remotePatterns`, deliberately.
   *
   * This file used to allow `hostname: "**"` for "remote company logos" — and nothing in the
   * product imports `next/image`, so the optimizer was pure attack surface with no user. It is
   * excluded from the proxy matcher, so `/_next/image?url=...` was an UNAUTHENTICATED way to make
   * the server fetch any https URL it can reach: server-side request forgery into whatever shares
   * the network, plus an open image proxy for someone else's bandwidth. On the co-hosted box that
   * network includes the neighbours.
   *
   * With no patterns configured, Next refuses every remote URL. If a later phase needs a remote
   * logo, add that specific hostname and nothing wider.
   */
};

export default withNextIntl(nextConfig);
