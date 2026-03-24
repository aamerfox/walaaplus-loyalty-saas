import createNextIntlPlugin from 'next-intl/plugin';
 
const withNextIntl = createNextIntlPlugin();
 
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone", // Enables Docker/VPS native hosting
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "**", // Allowing all image domains for remote company logos
      }
    ]
  }
};

export default withNextIntl(nextConfig);
