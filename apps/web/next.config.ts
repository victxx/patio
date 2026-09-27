import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  async rewrites() {
    return [{ source: "/", destination: "/landing/index.html" }];
  },
  transpilePackages: [
    "@patio/config",
    "@patio/ethereum",
    "@patio/protocol",
  ],
};

export default nextConfig;
