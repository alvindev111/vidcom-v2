export interface CliOutput {
  write(chunk: string): unknown;
}

/** Writes exactly one compact JSON object plus newline to an approved CLI output stream. */
export function writeJson(output: CliOutput, value: Record<string, unknown>): void {
  output.write(`${JSON.stringify(value)}\n`);
}
