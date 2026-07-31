import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
