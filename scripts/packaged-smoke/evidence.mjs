function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is missing or invalid`);
  }
  return value;
}

function rawFfprobe(value, label) {
  const report = object(value, label);
  if (!Array.isArray(report.streams) || report.streams.length === 0) {
    throw new Error(`${label} has no raw streams`);
  }
  for (const codecType of ["video", "audio"]) {
    if (!report.streams.some((stream) => stream?.codec_type === codecType)) {
      throw new Error(`${label} has no raw ${codecType} stream`);
    }
  }
  if (!report.format || typeof report.format !== "object"
    || !Number.isFinite(Number(report.format.duration))) {
    throw new Error(`${label} has no raw format duration`);
  }
  return report;
}

/** Builds M.6 evidence and refuses a nominally successful but incomplete run. */
export function completeSmokeEvidence(tag, context, environment = process.env) {
  const expectedTag = `${process.platform}-${process.arch}`;
  if (tag !== expectedTag) throw new Error(`platform evidence tag ${tag} differs from host ${expectedTag}`);

  const doctor = object(context?.measurements?.postMediaDoctor, "DoctorReport evidence");
  if (doctor.version !== 1 || doctor.platform !== tag || !Array.isArray(doctor.items) || doctor.items.length === 0) {
    throw new Error("DoctorReport evidence has incomplete schema or wrong platform");
  }
  const doctorIds = doctor.items.map((item) => item?.id).sort();
  if (JSON.stringify(doctorIds) !== JSON.stringify([...DOCTOR_ITEM_IDS].sort())) {
    throw new Error("DoctorReport evidence has an incomplete or unexpected item set");
  }
  const ffprobe = object(context?.measurements?.ffprobe, "ffprobe evidence");
  rawFfprobe(ffprobe.online, "online ffprobe evidence");
  rawFfprobe(ffprobe.offline, "offline ffprobe evidence");

  const identity = object(context?.identity, "artifact identity evidence");
  if (identity.platform !== tag || typeof identity.runtimeManifest !== "string"
    || identity.runtimeManifest.length === 0) {
    throw new Error("artifact identity evidence has incomplete platform/runtime metadata");
  }
  const provenance = object(context?.provenance, "artifact provenance evidence");
  if (provenance.platform !== tag || typeof provenance.commit !== "string"
    || typeof provenance.runtime?.artifactVersion !== "string") {
    throw new Error("artifact provenance evidence has incomplete platform/commit/runtime metadata");
  }
  const expectedCommit = environment.VIDCOM_SMOKE_EXPECTED_COMMIT;
  if (expectedCommit !== undefined && provenance.commit !== expectedCommit) {
    throw new Error("artifact provenance evidence does not match the workflow commit");
  }
  if (environment.VIDCOM_SMOKE_RELEASE === "1"
    && (!environment.RUNNER_OS || !environment.RUNNER_ARCH)) {
    throw new Error("release platform evidence requires GitHub runner OS and architecture metadata");
  }

  return Object.freeze({
    doctor,
    ffprobe,
    platform: Object.freeze({
      version: 1,
      tag,
      os: process.platform,
      architecture: process.arch,
      node: process.version,
      runnerOs: environment.RUNNER_OS ?? null,
      runnerArchitecture: environment.RUNNER_ARCH ?? null,
      artifact: Object.freeze({
        identity,
        manifest: Object.freeze({
          platform: provenance.platform,
          commit: provenance.commit,
          runtimeManifest: provenance.runtime.artifactVersion,
        }),
      }),
    }),
  });
}
const DOCTOR_ITEM_IDS = [
  "app-data.writable", "db.migration", "runtime.manifest", "runtime.integrity",
  "runtime.ffmpeg", "runtime.esbuild-binary", "compiler.probe", "runtime.hyperframes",
  "runtime.motion", "runtime.bgm", "runtime.python", "runtime.python-utf8", "chrome.cache",
  "tts.model-cache", "workspace.active", "port.available", "settings.file", "tts.elevenlabs",
];
