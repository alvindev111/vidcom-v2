import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is missing or invalid`);
  }
  return value;
}

async function nonEmpty(file, label) {
  let content;
  try {
    content = await readFile(file, "utf8");
  } catch {
    throw new Error(`${label} is missing: ${file}`);
  }
  if (content.trim().length === 0) throw new Error(`${label} is empty: ${file}`);
  return content;
}

async function json(file, label) {
  const content = await nonEmpty(file, label);
  try {
    return object(JSON.parse(content), label);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${label} is not valid JSON: ${file}`);
    throw error;
  }
}

function rawFfprobe(value, label) {
  const report = object(value, label);
  if (!Array.isArray(report.streams) || report.streams.length === 0) {
    throw new Error(`${label} has no streams`);
  }
  for (const codecType of ["video", "audio"]) {
    if (!report.streams.some((stream) => stream?.codec_type === codecType)) {
      throw new Error(`${label} has no ${codecType} stream`);
    }
  }
  if (!report.format || !Number.isFinite(Number(report.format.duration))) {
    throw new Error(`${label} has no format duration`);
  }
}

/** Refuses a successful M.6 upload when any required raw evidence is incomplete. */
export async function verifyEvidenceBundle({
  root,
  tag,
  expectedCommit,
  runnerOs,
  runnerArchitecture,
}) {
  if (!/^[0-9a-f]{40}$/u.test(expectedCommit)) {
    throw new Error("expected commit must be an exact 40-character Git SHA");
  }
  if (!tag || !runnerOs || !runnerArchitecture) {
    throw new Error("platform tag, runner OS and runner architecture are required");
  }

  const evidenceRoot = path.join(root, "packaged-smoke-evidence", tag);
  const artifactRoot = path.join(root, "dist", "artifact", tag);
  const files = {
    steps: path.join(root, `packaged-smoke-${tag}.json`),
    doctor: path.join(evidenceRoot, "doctor-report.json"),
    ffprobe: path.join(evidenceRoot, "ffprobe.json"),
    platform: path.join(evidenceRoot, "platform.json"),
    manifest: path.join(artifactRoot, "artifact-manifest.json"),
    checksums: path.join(artifactRoot, "SHA256SUMS"),
  };
  const [steps, doctor, ffprobe, platform, manifest, checksums] = await Promise.all([
    json(files.steps, "step report"),
    json(files.doctor, "raw DoctorReport"),
    json(files.ffprobe, "raw ffprobe report"),
    json(files.platform, "platform metadata"),
    json(files.manifest, "artifact manifest"),
    nonEmpty(files.checksums, "SHA256SUMS"),
  ]);

  if (steps.version !== 1 || steps.platform !== tag || !Array.isArray(steps.steps)
    || steps.steps.length === 0 || steps.steps.some((step) => step?.status !== "passed")) {
    throw new Error("step report is incomplete or contains a non-passing step");
  }
  if (doctor.version !== 1 || doctor.platform !== tag || !Array.isArray(doctor.items)
    || doctor.items.length === 0) {
    throw new Error("raw DoctorReport has incomplete schema or wrong platform");
  }
  rawFfprobe(ffprobe.online, "online raw ffprobe report");
  rawFfprobe(ffprobe.offline, "offline raw ffprobe report");

  if (platform.tag !== tag || platform.runnerOs !== runnerOs
    || platform.runnerArchitecture !== runnerArchitecture
    || platform.artifact?.manifest?.commit !== expectedCommit) {
    throw new Error("platform metadata does not match the runner and exact commit");
  }
  if (platform.artifact?.identity?.platform !== tag
    || platform.artifact.identity.runtimeManifest !== manifest.runtime?.artifactVersion) {
    throw new Error("artifact identity metadata is incomplete or names a different runtime");
  }
  if (manifest.version !== 1 || manifest.platform !== tag || manifest.commit !== expectedCommit) {
    throw new Error("artifact manifest does not match the platform and exact commit");
  }
  if (platform.artifact?.manifest?.runtimeManifest !== manifest.runtime?.artifactVersion) {
    throw new Error("platform metadata and artifact manifest identify different runtimes");
  }
  const checksumLines = checksums.trim().split(/\r?\n/u);
  const checksum = /^([0-9a-f]{64})\s{2}(\S+)$/u.exec(checksumLines[0] ?? "");
  const manifestFiles = object(manifest.files, "artifact manifest files");
  const entries = Object.entries(manifestFiles);
  if (checksumLines.length !== 1 || !checksum || entries.length !== 1
    || entries[0]?.[0] !== checksum[2] || entries[0]?.[1] !== checksum[1]) {
    throw new Error("SHA256SUMS must contain exactly one canonical artifact digest");
  }

  return Object.freeze({ tag, commit: expectedCommit });
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const invokedAsScript = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedAsScript) {
  verifyEvidenceBundle({
    root: option("--root") ?? process.cwd(),
    tag: option("--tag"),
    expectedCommit: process.env.VIDCOM_SMOKE_EXPECTED_COMMIT,
    runnerOs: process.env.RUNNER_OS,
    runnerArchitecture: process.env.RUNNER_ARCH,
  }).then(
    (evidence) => process.stdout.write(`${JSON.stringify(evidence)}\n`),
    (error) => {
      process.stderr.write(`packaged-smoke evidence: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
