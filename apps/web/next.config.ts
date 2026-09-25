import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Workspace packages are consumed as TypeScript source, so a change in a
  // package is picked up without a separate build step.
  transpilePackages: ['@civora/domain'],
  // Emitted for the container image. The tracing root is inferred from the
  // workspace lockfile, which keeps the runtime bundle to what the server
  // actually imports.
  output: 'standalone',
  typedRoutes: false,
};

export default nextConfig;
