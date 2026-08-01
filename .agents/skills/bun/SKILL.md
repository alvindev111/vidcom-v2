---
name: Bun
description: Use when building, running, testing, or bundling JavaScript/TypeScript applications. Reach for Bun when you need to execute code, manage dependencies, write tests, or bundle projects — it's a complete toolkit replacing Node.js, npm, Jest, and esbuild.
metadata:
    mintlify-proj: bun
    version: "1.0"
---

# Bun Skill Reference

## Product Summary

Bun is an all-in-one JavaScript/TypeScript toolkit that replaces Node.js, npm, Jest, and esbuild. It ships as a single binary (`bun`) and includes a runtime, package manager, test runner, and bundler. The runtime uses JavaScriptCore (Apple's engine) and is written in Rust, making it 4x faster than Node.js on startup.

**Key files and commands:**
- `bunfig.toml` — Configuration file (optional; Bun works zero-config)
- `package.json` — Standard Node.js format; Bun reads `scripts`, `dependencies`, `devDependencies`
- `bun.lock` — Bun's lockfile (text-based by default since v1.2)
- `bun run <file>` — Execute TypeScript/JSX directly (no transpile step needed)
- `bun install` — Install dependencies 25x faster than npm
- `bun test` — Jest-compatible test runner
- `bun build` — Bundle for browser or server

**Primary docs:** https://bun.com/docs

---

## When to Use

Reach for Bun when:

- **Running code**: Execute `.ts`, `.tsx`, `.js`, `.jsx` files directly without setup
- **Managing dependencies**: Install, add, remove, or audit packages faster than npm/yarn/pnpm
- **Writing tests**: Run Jest-compatible tests with TypeScript support and watch mode
- **Bundling**: Build for browser or server with native TypeScript/JSX/CSS support
- **Building servers**: Create HTTP servers with `Bun.serve()` and routing
- **Scripting**: Run `package.json` scripts with `bun run <script>`
- **Migrating from Node.js**: Drop-in replacement for existing Node.js projects

Do not use Bun for:
- Type checking (use `tsc` separately)
- Generating type declarations (use `tsc --emitDeclarationOnly`)
- Projects requiring Node.js-specific APIs not yet implemented in Bun

---

## Quick Reference

### Essential Commands

| Task | Command |
|------|---------|
| Run a file | `bun run index.ts` or `bun index.ts` |
| Run with watch | `bun --watch run index.ts` |
| Run a script | `bun run dev` (from `package.json` scripts) |
| Install all deps | `bun install` |
| Add a package | `bun add react` |
| Add dev dependency | `bun add -d @types/react` |
| Remove a package | `bun remove react` |
| Run tests | `bun test` |
| Run tests in watch | `bun --watch test` |
| Build a bundle | `bun build ./index.ts --outdir ./out` |
| Build with watch | `bun build ./index.ts --outdir ./out --watch` |

### File Type Support (Runtime)

Bun transpiles on the fly; no configuration needed:

| Extension | Behavior |
|-----------|----------|
| `.ts`, `.tsx` | TypeScript + JSX → JavaScript |
| `.js`, `.jsx` | JSX → JavaScript |
| `.json`, `.toml`, `.yaml` | Parsed and inlined as objects |
| `.html` | Bundled with assets |
| `.css` | Bundled together |

### Configuration File (`bunfig.toml`)

Optional; place in project root. Common sections:

```toml
[serve]
port = 3000

[test]
coverage = true
timeout = 5000

[install]
linker = "hoisted"  # or "isolated"
dev = true
optional = true
```

See `runtime/bunfig` docs for full reference.

---

## Decision Guidance

### When to Use `bun run` vs `bun`

| Scenario | Use |
|----------|-----|
| Execute a file directly | `bun index.ts` |
| Run a `package.json` script | `bun run dev` |
| Pass flags to Bun | `bun --watch run dev` |
| Run system commands in scripts | `bun run <script>` (uses shell) |

### Installation Strategy: Hoisted vs Isolated

| Strategy | Use When |
|----------|----------|
| `hoisted` | Traditional npm behavior; dependencies in shared `node_modules` |
| `isolated` | Monorepos; prevents phantom dependencies; stricter isolation |

Default: `hoisted` for single packages, `isolated` for workspaces.

### Test Execution: Sequential vs Concurrent

| Mode | Use When |
|------|----------|
| Sequential (default) | Tests have shared state or order dependencies |
| `--concurrent` | Tests are independent; want faster execution |
| `test.serial` | Mark individual tests that must run in order |

### Bundler Target

| Target | Use When |
|--------|----------|
| `browser` | Client-side code; default for ESM |
| `bun` | Server-side code; full-stack apps with HTML imports |
| `node` | Node.js compatibility; CommonJS output |

---

## Workflow

### 1. Initialize a Project

```bash
bun init my-app
# Choose template: Blank, React, or Library
cd my-app
```

This creates `package.json`, `tsconfig.json`, and `index.ts`.

### 2. Install Dependencies

```bash
bun install
# or add specific packages
bun add react zod
bun add -d @types/react
```

Bun creates `bun.lock` (text-based lockfile) and `node_modules/`.

### 3. Write and Run Code

Create `index.ts` (TypeScript works out of the box):

```typescript
import { serve } from "bun";

Bun.serve({
  port: 3000,
  routes: {
    "/": () => new Response("Hello!"),
  },
});
```

Run it:

```bash
bun run index.ts
# or
bun index.ts
```

### 4. Add Scripts to `package.json`

```json
{
  "scripts": {
    "dev": "bun run index.ts",
    "build": "bun build ./index.ts --outdir ./dist",
    "test": "bun test"
  }
}
```

Run with `bun run dev`.

### 5. Write Tests

Create `math.test.ts`:

```typescript
import { test, expect } from "bun:test";

test("2 + 2 = 4", () => {
  expect(2 + 2).toBe(4);
});
```

Run tests:

```bash
bun test
bun --watch test  # watch mode
bun test --coverage  # with coverage
```

### 6. Build for Production

```bash
bun build ./index.ts --outdir ./dist --minify
```

Outputs optimized bundles in `./dist/`.

### 7. Verify Before Commit

- Run tests: `bun test`
- Check types: `tsc --noEmit` (separate step)
- Build: `bun build ./index.ts --outdir ./dist`
- Lint: Use ESLint or similar (not built into Bun)

---

## Common Gotchas

### 1. **Bun Flags Must Come Before `run`**
```bash
bun --watch run dev  # ✅ correct
bun run dev --watch  # ❌ wrong; --watch goes to the script
```

### 2. **Lifecycle Scripts Are Not Executed by Default**
Bun skips `postinstall` scripts for security. Add trusted packages to `package.json`:
```json
{
  "trustedDependencies": ["esbuild", "sharp"]
}
```

### 3. **No Type Checking in Runtime**
Bun transpiles TypeScript but does not type-check. Run `tsc --noEmit` separately in CI.

### 4. **`bunfig.toml` Is Optional**
Bun works zero-config. Only add `bunfig.toml` if you need custom behavior.

### 5. **Lockfile Format Changed in v1.2**
Old projects use binary `bun.lockb`. Upgrade with:
```bash
bun install --save-text-lockfile --frozen-lockfile --lockfile-only
rm bun.lockb
```

### 6. **Watch Mode Restarts the Entire Process**
Changes to imported files trigger a full restart, not hot reload (unless using `--hot` with bundler).

### 7. **`bun.lock` Should Be Committed**
Commit `bun.lock` to version control for reproducible installs. Use `bun ci` in CI/CD instead of `bun install`.

### 8. **Peer Dependencies Are Installed by Default**
Unlike npm, Bun installs `peerDependencies` automatically. Disable with `--omit peer` if needed.

### 9. **Auto-Install Can Mask Missing Dependencies**
By default, Bun auto-installs missing packages at runtime. Disable with `[install] auto = "disable"` in `bunfig.toml` for stricter checks.

### 10. **Minification Doesn't Downconvert Syntax**
`bun build --minify` does not transpile modern syntax to older targets. Use `tsconfig.json` `target` field if needed.

---

## Verification Checklist

Before submitting code or deploying:

- [ ] **Tests pass**: `bun test` exits with code 0
- [ ] **No type errors**: `tsc --noEmit` (if using TypeScript)
- [ ] **Build succeeds**: `bun build ./index.ts --outdir ./dist` completes without errors
- [ ] **Dependencies locked**: `bun.lock` is committed (for reproducible installs)
- [ ] **Scripts work**: `bun run <script>` executes without errors
- [ ] **Watch mode works**: `bun --watch run dev` detects file changes
- [ ] **Trusted dependencies declared**: Any packages with lifecycle scripts are in `trustedDependencies`
- [ ] **No console errors**: Run the app and check for runtime errors
- [ ] **Lockfile matches package.json**: No untracked changes after `bun install`

---

## Resources

**Comprehensive navigation:** https://bun.com/docs/llms.txt

**Critical documentation pages:**
1. [Bun Runtime](https://bun.com/docs/runtime) — Execute files and scripts
2. [Package Manager](https://bun.com/docs/pm/cli/install) — Install and manage dependencies
3. [Test Runner](https://bun.com/docs/test) — Write and run tests
4. [Bundler](https://bun.com/docs/bundler) — Bundle for browser or server
5. [bunfig.toml](https://bun.com/docs/runtime/bunfig) — Configuration reference

---

> For additional documentation and navigation, see: https://bun.com/docs/llms.txt