#!/usr/bin/env node
import { register } from "tsx/esm/api";

register();
const { runCliMain } = await import("../src/main.ts");
process.exitCode = await runCliMain(process.argv.slice(2));
