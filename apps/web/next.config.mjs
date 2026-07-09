/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@clipfactory/core"],
  reactStrictMode: true,
  env: {
    // Baked in at build time. Set API_URL (or NEXT_PUBLIC_API_URL) to the API's
    // public URL when building for production.
    NEXT_PUBLIC_API_URL:
      process.env.NEXT_PUBLIC_API_URL ?? process.env.API_URL ?? "http://localhost:3001",
  },
};

export default nextConfig;
