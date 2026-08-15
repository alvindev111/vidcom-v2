"use strict";

// Node evaluates this tiny built-in-only file as the SEA main. The product
// bootstrap itself is a raw asset, so the bytes the verifier hashes are also
// the bytes this loader executes; main A can no longer merely report asset B.
const { Module } = process.getBuiltinModule("node:module");
const { getRawAsset } = process.getBuiltinModule("node:sea");
const { runInThisContext } = process.getBuiltinModule("node:vm");

const PRIMARY_ASSET = "__vidcom/primary.cjs";
const LOADER_PROTOCOL = "vidcom-sea-primary-loader-v1";
Object.defineProperty(globalThis, "__VIDCOM_SEA_PRIMARY_LOADER__", {
  configurable: false,
  enumerable: false,
  value: LOADER_PROTOCOL,
  writable: false,
});

const source = Buffer.from(getRawAsset(PRIMARY_ASSET)).toString("utf8");
const filename = PRIMARY_ASSET;
const loaded = new Module(filename);
loaded.filename = filename;
loaded.paths = [];
const compile = runInThisContext(Module.wrap(source), { filename });
const builtinRequire = (specifier) => process.getBuiltinModule(specifier);
compile.call(loaded.exports, loaded.exports, builtinRequire, loaded, filename, "");
