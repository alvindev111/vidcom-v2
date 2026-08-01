import { getAsset, isSea } from "node:sea";
import {
  type NativeRuntimeManifest,
  runPackagedNativeProbe,
} from "./runtime-loader";

async function main() {
  if (!isSea()) {
    throw new Error("This entry must run from a Node SEA executable");
  }

  const archive = new Uint8Array(getAsset("native-runtime.tar.gz"));
  const manifest = JSON.parse(
    new TextDecoder().decode(getAsset("native-runtime-manifest.json")),
  ) as NativeRuntimeManifest;
  const result = await runPackagedNativeProbe({
    archive,
    manifest,
    host: "node-sea",
  });

  console.log(JSON.stringify(result, null, 2));
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
