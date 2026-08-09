import {
  doctorExitCode,
  formatDoctorReport,
  redactDoctorReport,
  runDoctorChecks,
  type DoctorItem,
} from "@vidcom/core";

import { CliInputError } from "../cli-error";
import {
  createDoctorChecks,
  doctorCheckIsRequired,
  type DoctorContext,
} from "./doctor-checks";

export interface DoctorCommandOptions {
  json?: boolean;
  deep?: boolean;
  repair?: boolean;
}

export function parseDoctorCommandArgs(argv: readonly string[]): DoctorCommandOptions {
  const options: DoctorCommandOptions = {};
  for (const flag of argv) {
    if (flag !== "--json" && flag !== "--deep" && flag !== "--repair") {
      throw new CliInputError(`unknown doctor argument: ${flag}`);
    }
    const key = flag.slice(2) as keyof DoctorCommandOptions;
    if (options[key]) throw new CliInputError(`${flag} may be provided only once`);
    options[key] = true;
  }
  return options;
}

export interface DoctorIo {
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
}

export interface RepairOutcome {
  items: DoctorItem[];
}

export interface DoctorRunInput {
  context: DoctorContext;
  options: DoctorCommandOptions;
  io?: DoctorIo;
  strict?: boolean;
  /** Absolute paths from the build machine, stripped before anything is printed. */
  buildRoots?: readonly string[];
  /** Re-extracts runtime components. Only runtime components; never settings or projects. */
  repair?(failing: readonly DoctorItem[]): Promise<RepairOutcome>;
}

export async function runDoctor(input: DoctorRunInput): Promise<number> {
  const io = input.io ?? { stdout: process.stdout, stderr: process.stderr };
  let report = await runDoctorChecks(createDoctorChecks(), input.context, {
    platform: input.context.platform,
    ...(input.strict === undefined ? {} : { strict: input.strict }),
  });

  if (input.options.repair === true) {
    const failing = report.items.filter(
      (item) => item.status !== "ok" && item.status !== "skipped",
    );
    if (input.repair === undefined) {
      throw new CliInputError("this build cannot repair itself");
    }
    // A repair that cannot run must not take the diagnosis with it. This is a
    // command whose whole job is to say what is wrong; throwing here left it
    // saying nothing at all, which the packaged smoke caught.
    let repaired: RepairOutcome | null = null;
    let repairFailure: string | null = null;
    try {
      repaired = await input.repair(failing);
    } catch (error) {
      repairFailure = error instanceof Error ? error.message : String(error);
    }
    if (repaired) {
      // The report is rebuilt from the repaired items rather than patched in
      // place: a repair that half-worked has to show as it is now, not as a mix
      // of before and after.
      report = {
        ...report,
        items: report.items.map(
          (item) => repaired.items.find((entry) => entry.id === item.id) ?? item,
        ),
      };
    } else if (repairFailure !== null) {
      // Recorded against the items it was meant to fix, so the reason travels
      // with the thing that is still broken rather than in a separate line.
      report = {
        ...report,
        items: report.items.map((item) => failing.some((entry) => entry.id === item.id)
          ? { ...item, remedy: `${item.remedy ?? "repair could not run"} (repair failed: ${repairFailure})` }
          : item),
      };
    }
  }

  const redacted = redactDoctorReport(report, input.buildRoots ?? []);
  // JSON on stdout, prose on stderr. That is what lets `doctor --json | jq`
  // work while a human running it still sees something readable.
  if (input.options.json === true) io.stdout.write(`${JSON.stringify(redacted, null, 2)}\n`);
  else io.stderr.write(`${formatDoctorReport(redacted)}\n`);

  return doctorExitCode(redacted, doctorCheckIsRequired);
}
