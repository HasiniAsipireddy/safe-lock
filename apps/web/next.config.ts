import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // @safelock/shared is published as raw TypeScript inside the workspace.
  transpilePackages: ['@safelock/shared'],
};

export default nextConfig;
