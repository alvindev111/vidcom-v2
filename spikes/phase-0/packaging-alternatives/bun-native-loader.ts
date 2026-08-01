import archivePath from "../.artifacts/packaging-alternatives/native-runtime.tar.gz" with { type: "file" };
import manifestPath from "../.artifacts/packaging-alternatives/native-runtime-manifest.txt" with { type: "file" };
import {
  type NativeRuntimeManifest,
  runPackagedNativeProbe,
} from "./runtime-loader";

declare const Bun: {
  file(path: string): {
    bytes(): Promise<Uint8Array>;
    json(): Promise<unknown>;
  };
};

const [archive, manifest] = await Promise.all([
  Bun.file(archivePath).bytes(),
  Bun.file(manifestPath).json() as Promise<NativeRuntimeManifest>,
]);
const result = await runPackagedNativeProbe({
  archive,
  manifest,
  host: "bun-loader",
});

console.log(JSON.stringify(result, null, 2));
