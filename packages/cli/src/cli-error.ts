/** Stable input/domain rejection used by the CLI exit-code boundary. */
export class CliInputError extends Error {
  readonly exitCode = 2;

  constructor(message: string) {
    super(message);
    this.name = "CliInputError";
  }
}
