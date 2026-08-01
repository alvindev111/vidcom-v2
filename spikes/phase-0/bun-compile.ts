type ProbeResult = { ok: true; value: unknown } | { ok: false; error: string };

async function probe(run: () => Promise<unknown>): Promise<ProbeResult> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

const results = {
  hyperframes: await probe(async () => {
    const { buildHyperframesRuntimeScript, getHyperframeRuntimeScript } =
      await import("@hyperframes/core");
    const hyperframesRuntime = getHyperframeRuntimeScript();
    const sourceBuild = buildHyperframesRuntimeScript();
    return {
      embeddedRuntimeBytes: Buffer.byteLength(hyperframesRuntime),
      sourceBuild:
        sourceBuild === null
          ? "published-package-has-no-entry-source"
          : "built",
    };
  }),
  esbuild: await probe(async () => {
    const { transformSync } = await import("esbuild");
    return transformSync("const answer: number = 42", {
      loader: "ts",
    }).code.trim();
  }),
  onnxruntime: await probe(async () => {
    const ort = await import("onnxruntime-node");
    return {
      version: ort.env.versions.node,
      backends: ort.listSupportedBackends(),
    };
  }),
  sharp: await probe(async () => {
    const { default: sharp } = await import("sharp");
    const png = await sharp({
      create: {
        width: 2,
        height: 3,
        channels: 4,
        background: { r: 12, g: 34, b: 56, alpha: 1 },
      },
    })
      .png()
      .toBuffer();
    const metadata = await sharp(png).metadata();
    return {
      width: metadata.width,
      height: metadata.height,
      format: metadata.format,
      outputBytes: png.byteLength,
    };
  }),
  puppeteerCore: await probe(async () => {
    const { default: puppeteer } = await import("puppeteer-core");
    const chromiumArgs = await puppeteer.defaultArgs();
    return {
      chromiumArgumentCount: chromiumArgs.length,
      firstChromiumArgument: chromiumArgs[0],
    };
  }),
};

console.log(
  JSON.stringify(
    {
      runtime: "bun",
      probes: results,
    },
    null,
    2,
  ),
);

if (Object.values(results).some((result) => !result.ok)) {
  process.exitCode = 1;
}

export {};
