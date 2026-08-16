/**
 * Static export, because the user must never have to run a Node server.
 *
 * The Python package is the backend and the only source of truth. This
 * project is a view: `next build` produces a directory of plain files that
 * ship inside the wheel, and a post-build step folds that directory into the
 * single self-contained document the MCP Apps resource carries inline.
 *
 * `images.unoptimized` is not a preference — the optimizer is a runtime
 * service, and a build that emitted `/_next/image?...` URLs would produce a
 * workspace that renders blank under a CSP with no remote origins.
 *
 * `assetPrefix` stays empty and paths stay relative: the bundle is opened
 * from a resource URI, a dev host, and a file path, and an absolute `/_next`
 * resolves against the wrong root in at least two of those.
 */

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",
  // Left at the default. `distDir` is resolved *relative to the project*, so
  // an absolute path on another drive is silently joined onto this one and
  // the build dies in `mkdir`. Keeping the build off the repo drive is done
  // with a directory junction instead, which Next never sees.
  distDir: ".next",
  // Relative asset paths so the same build works from a resource URI, a dev
  // host and a file:// path.
  assetPrefix: undefined,
  images: { unoptimized: true },
  reactStrictMode: true,
  // No build id churn: a stable id keeps the inlined bundle byte-comparable
  // between builds, which is what makes "did the UI actually change" a
  // question with an answer.
  generateBuildId: async () => "watch-skill-workspace",
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: false },
  // Telemetry is disabled via NEXT_TELEMETRY_DISABLED in the build script;
  // there is no config key for it, and a build that phones home would fail
  // the zero-egress gate.
};

export default nextConfig;
