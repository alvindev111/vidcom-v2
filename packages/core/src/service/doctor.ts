export type DoctorStatus = "ok" | "missing" | "broken" | "skipped";

export interface DoctorItem {
  id: string;
  status: DoctorStatus;
  /** What is wrong, in one line. Empty for `ok`. */
  detail?: string;
  /** What the user can do about it. Required for anything that is not `ok`. */
  remedy?: string;
}

export interface DoctorCheck<Context> {
  id: string;
  required: boolean;
  run(context: Context): Promise<DoctorItem>;
  repair?(context: Context): Promise<DoctorItem>;
}

export interface DoctorReport {
  version: 1;
  platform: string;
  items: DoctorItem[];
}

/**
 * The order every report is written in.
 *
 * Fixed here rather than taken from whatever order the checks were registered
 * in, because registration order follows import order and import order is not a
 * thing anybody controls. The golden report pins this list, so a check that
 * moves has to move here first.
 *
 * `gpu.cuda` is deliberately absent: the shipped stack is CPU-only
 * `onnxruntime`, so the check could never return `ok`, and an item that is
 * permanently not-ok teaches people to ignore the whole report.
 */
export const DOCTOR_CHECK_ORDER: readonly string[] = [
  "app-data.writable",
  "db.migration",
  "runtime.manifest",
  "runtime.integrity",
  "runtime.ffmpeg",
  "runtime.esbuild-binary",
  "compiler.probe",
  "runtime.hyperframes",
  "runtime.motion",
  "runtime.python",
  "runtime.python-utf8",
  "chrome.cache",
  "tts.model-cache",
  "workspace.active",
  "port.available",
  "settings.file",
  "tts.elevenlabs",
];

export interface DoctorRunOptions {
  platform: string;
  /** In the packaged smoke a skipped required item is a failure, not a "not yet". */
  strict?: boolean;
}

function orderOf(id: string): number {
  const index = DOCTOR_CHECK_ORDER.indexOf(id);
  // An unlisted check sorts last rather than throwing: a report that omits a
  // new check is less useful than one that shows it in an odd place.
  return index === -1 ? DOCTOR_CHECK_ORDER.length : index;
}

/**
 * Runs every check and reports all of them.
 *
 * No short-circuit on the first failure. Somebody running `doctor` wants the
 * whole picture, and stopping early turns one broken install into as many runs
 * as it has problems.
 */
export async function runDoctorChecks<Context>(
  checks: readonly DoctorCheck<Context>[],
  context: Context,
  options: DoctorRunOptions,
): Promise<DoctorReport> {
  const ordered = [...checks].sort((left, right) => orderOf(left.id) - orderOf(right.id));
  const items: DoctorItem[] = [];
  for (const check of ordered) {
    let item: DoctorItem;
    try {
      item = await check.run(context);
    } catch (error) {
      // A check that throws is a broken check, and saying so is more useful
      // than losing the entire report to one unhandled rejection.
      item = {
        id: check.id,
        status: "broken",
        detail: error instanceof Error ? error.message : String(error),
        remedy: "this check failed to run; report it with the detail above",
      };
    }
    items.push(
      options.strict === true && check.required && item.status === "skipped"
        ? {
          ...item,
          status: "missing",
          detail: item.detail ?? "required component was never exercised",
        }
        : item,
    );
  }
  return { version: 1, platform: options.platform, items };
}

/**
 * Non-zero only when something required is wrong.
 *
 * An optional item that is not ok must not fail the command: it describes the
 * machine or the user's own configuration, and exiting non-zero for it would
 * make `doctor` useless in a script that only cares whether the app can run.
 */
export function doctorExitCode(
  report: DoctorReport,
  isRequired: (id: string) => boolean,
): number {
  const failed = report.items.some(
    (item) => isRequired(item.id) && item.status !== "ok" && item.status !== "skipped",
  );
  return failed ? 1 : 0;
}

const SECRET_KEYS = /(token|secret|api[-_]?key|credential|password|bearer)/iu;

/**
 * Strips what a report must never carry into a bug tracker.
 *
 * Doctor output is the thing users paste into issues, so it is the one place
 * where a leaked key travels furthest. Absolute paths from the build machine go
 * too: they say nothing about the user's install and everything about ours.
 */
export function redactDoctorReport(report: DoctorReport, buildRoots: readonly string[] = []): DoctorReport {
  const scrub = (value: string): string => {
    let text = value;
    for (const root of buildRoots) {
      if (root.length > 0) text = text.split(root).join("<build>");
    }
    return text.replace(
      /\b([\w.-]*(?:token|secret|key|credential|password|bearer)[\w.-]*)\s*[:=]\s*\S+/giu,
      "$1=<redacted>",
    );
  };
  return {
    ...report,
    items: report.items.map((item) => ({
      ...item,
      ...(item.detail === undefined ? {} : { detail: SECRET_KEYS.test(item.id) ? "<redacted>" : scrub(item.detail) }),
      ...(item.remedy === undefined ? {} : { remedy: scrub(item.remedy) }),
    })),
  };
}

/** One line per item, so a terminal reader sees the same order the JSON has. */
export function formatDoctorReport(report: DoctorReport): string {
  return report.items.map((item) => {
    const head = `${item.status.padEnd(7)} ${item.id}`;
    if (item.status === "ok") return head;
    // A skipped item has nothing to fix — it has not been reached yet — and
    // printing "fix: unknown" beside it reads as a defect in the report.
    if (item.status === "skipped") {
      return item.detail === undefined ? head : `${head}\n        ${item.detail}`;
    }
    // Every non-ok line carries a remedy. A report that says what is wrong but
    // not what to do is a report the reader has to take somewhere else.
    return `${head}\n        ${item.detail ?? "no detail"}\n        fix: ${item.remedy ?? "unknown"}`;
  }).join("\n");
}
