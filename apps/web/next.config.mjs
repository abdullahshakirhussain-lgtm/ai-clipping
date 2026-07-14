/** @type {import('next').NextConfig} */

// Backend URL the Next server proxies to. Read at build time (Railway passes it
// as a build arg via Dockerfile.web).
const API_UPSTREAM =
  process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

const nextConfig = {
  transpilePackages: ["@clipfactory/core"],
  reactStrictMode: true,
  // Lint runs as its own step (`pnpm lint`), not as part of `next build`. Without
  // this, the build's ESLint pass trips over rules that aren't wired into the web
  // app's config (e.g. react-hooks/exhaustive-deps referenced by a disable
  // comment), failing the Railway build for a non-error.
  eslint: { ignoreDuringBuilds: true },
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
