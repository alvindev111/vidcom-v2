#!/usr/bin/env node
import { register } from "tsx/esm/api";

const emitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, ...args) => {
  const type = typeof args[0] === "string" ? args[0] : args[0]?.type;
  if (type === "ExperimentalWarning"
    && String(warning) === "SQLite is an experimental feature and might change at any time") return;
  emitWarning(warning, ...args);
};

register();
const { runCliMain } = await import("../src/main.ts");
process.exitCode = await runCliMain(process.argv.slice(2));
