/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@clipfactory/core"],
  reactStrictMode: true,
  env: {
    NEXT_PUBLIC_API_URL: process.env.API_URL ?? "http://localhost:3001",
  },
};

export default nextConfig;
