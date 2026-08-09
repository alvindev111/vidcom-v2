import { runBootstrappedCli } from "./boot";

async function main(): Promise<void> {
  process.exitCode = await runBootstrappedCli(process.argv.slice(2));
}

void main().catch(() => {
  process.stderr.write("internal_error\n");
  process.exitCode = 1;
});

