/** @type {import('next').NextConfig} */

// Backend URL the Next server proxies to. Read at build time (Railway passes it
// as a build arg via Dockerfile.web).
const API_UPSTREAM =
  process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

const nextConfig = {
  transpilePackages: ["@clipfactory/core"],
  reactStrictMode: true,
  // The /api/* proxy (rewrites below) buffers request bodies in memory and caps
  // them at 10MB by default (Next 15: experimental.middlewareClientMaxBodySize),
  // truncating video uploads and resetting the socket. Raise the cap so real
  // videos pass through. Note: the body is buffered in the web container's RAM,
  // so uploads are bounded by its memory — the durable fix for very large files
  // is presigned direct-to-R2 upload.
  experimental: { middlewareClientMaxBodySize: "2gb" },
  // Proxy every /api/* request to the backend so the browser only ever talks to
  // the web origin. This keeps the Better Auth session cookie FIRST-PARTY —
  // otherwise the web and API live on different subdomains, the browser treats
  // the cookie as third-party, and Chrome blocks it (login bounces to sign-in).
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${API_UPSTREAM}/api/:path*` }];
  },
};

export default nextConfig;
