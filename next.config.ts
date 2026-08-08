import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The artifact serves the frontend from a pack embedded in the executable,
  // with no Node rendering anything at request time. The API is not part of
  // that output: the daemon owns it, and the browser reaches it over the same
  // loopback origin in the artifact or a configured one in development.
  output: "export",
  // Stated rather than left to the default. A static export writes `/a/b.html`
  // or `/a/b/index.html` depending on this flag, and the SEA asset host maps
  // request paths to those files — so the two have to agree, and agreeing by
  // accident is how they drift apart later.
  trailingSlash: false,
  // The HyperFrames packages are Node-only: @hyperframes/core reaches into
  // esbuild (a native binary) from its HTML compiler, and studio-server reads
  // the project off disk. Bundling them into the server build fails, so keep
  // them external and let Node require them at runtime.
  serverExternalPackages: [
    "@hyperframes/core",
    "@hyperframes/studio-server",
    "@hyperframes/sdk",
    "@hyperframes/parsers",
    "@hyperframes/lint",
    "esbuild",
    // Keep one copy: the hyperframes packages require linkedom at runtime, and a
    // second bundled copy would mean two DOMParser implementations.
    "linkedom",
  ],
};

export default nextConfig;
