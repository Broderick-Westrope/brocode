# RTK Permission Pattern Fix

> **Status:** COMPLETED

## Specification

**Problem:** When RTK is active, its `tool.execute.before` plugin hook rewrites `args.command` from e.g. `cat file.txt` to `rtk cat file.txt` _before_ the bash tool's `execute()` function runs. The bash tool then parses the rewritten command and generates permission patterns from it. Since `rtk` is not in the `ARITY` dictionary, `BashArity.prefix(["rtk", "cat", "file.txt"])` falls through to the default `tokens.slice(0, 1)` → `["rtk"]`, producing the "Always Allow" pattern `rtk *` instead of `cat *`. This means every RTK-wrapped command collapses into a single useless pattern.

A secondary effect: the `FILES.has(cmd)` check at `bash.ts:253` also fails because `cmd` is `"rtk"` instead of the actual command (e.g. `"cat"`), so directory permission checks are skipped for RTK-rewritten file commands.

**Goal:** When RTK rewrites a command, the permission UI shows the correct "Always Allow" pattern (e.g. `cat *`, `git checkout *`) and file-directory permission checks work for the underlying command.

**Scope:**

- In: Fix permission pattern generation to strip transparent wrapper prefixes like `rtk`
- In: Fix `FILES` check to use the unwrapped command
- In: Add tests for wrapper stripping
- Out: Changes to RTK itself, plugin hook timing changes, making wrappers user-configurable

**Success Criteria:**

- [ ] `BashArity.prefix(["rtk", "cat", "file.txt"])` returns `["cat"]` (not `["rtk"]`)
- [ ] `BashArity.prefix(["rtk", "git", "status"])` returns `["git", "status"]`
- [ ] `BashArity.prefix(["rtk", "npm", "run", "dev"])` returns `["npm", "run", "dev"]`
- [ ] `BashArity.prefix(["rtk"])` returns `["rtk"]` (bare `rtk` with no subcommand is not stripped)
- [ ] Directory permission checks trigger for `rtk cat /outside/file.txt`
- [ ] Non-RTK commands are unaffected

## Context Loading

```bash
read packages/opencode/src/permission/arity.ts
read packages/opencode/src/tool/bash.ts:241-270
read packages/opencode/test/permission/arity.test.ts
```

## Tasks

### Task 1: Strip RTK prefix in `collect()` and `BashArity.prefix()`

**Context:** `packages/opencode/src/permission/arity.ts`, `packages/opencode/src/tool/bash.ts`, `packages/opencode/test/permission/arity.test.ts`

**Files:**

- Modify: `packages/opencode/src/permission/arity.ts` (strip wrapper prefix)
- Modify: `packages/opencode/src/tool/bash.ts` (strip wrapper before `FILES.has()` check)
- Modify: `packages/opencode/test/permission/arity.test.ts` (add wrapper tests)

**Steps:**

1. [ ] In `packages/opencode/src/permission/arity.ts`, add a constant for transparent wrapper commands and strip them in `prefix()`:

   Add above the `prefix` function:

   ```typescript
   const WRAPPERS = new Set(["rtk"])
   ```

   At the start of `prefix()`, before the main `for` loop, add wrapper stripping:

   ```typescript
   if (tokens.length > 1 && WRAPPERS.has(tokens[0])) {
     return prefix(tokens.slice(1))
   }
   ```

   This recursive call ensures the stripped tokens go through normal ARITY lookup. A bare `rtk` (no subcommand) falls through to the existing default at line 9.

2. [ ] In `packages/opencode/src/tool/bash.ts`, in the `collect()` function (line 248-266), strip the wrapper prefix from tokens before the `FILES.has(cmd)` check:

   Replace lines 249-251:

   ```typescript
   const command = parts(node)
   const tokens = command.map((item) => item.text)
   const cmd = ps ? tokens[0]?.toLowerCase() : tokens[0]
   ```

   With:

   ```typescript
   const command = parts(node)
   const raw = command.map((item) => item.text)
   const tokens = raw.length > 1 && raw[0] === "rtk" ? raw.slice(1) : raw
   const cmd = ps ? tokens[0]?.toLowerCase() : tokens[0]
   ```

   This ensures `FILES.has(cmd)` checks the underlying command (e.g. `cat`) rather than `rtk`, so directory permission prompts fire correctly for RTK-wrapped file operations.

   Note: `scan.patterns.add(source(node))` on line 264 still shows the full command including `rtk` prefix — this is correct because the user should see what will actually execute.

3. [ ] In `packages/opencode/test/permission/arity.test.ts`, add a test block for RTK wrapper stripping:

   ```typescript
   test("rtk wrapper is stripped", () => {
     expect(BashArity.prefix(["rtk", "cat", "file.txt"])).toEqual(["cat"])
     expect(BashArity.prefix(["rtk", "git", "checkout", "main"])).toEqual(["git", "checkout"])
     expect(BashArity.prefix(["rtk", "npm", "run", "dev"])).toEqual(["npm", "run", "dev"])
     expect(BashArity.prefix(["rtk", "docker", "compose", "up"])).toEqual(["docker", "compose", "up"])
   })

   test("bare rtk is not stripped", () => {
     expect(BashArity.prefix(["rtk"])).toEqual(["rtk"])
   })
   ```

**Verify:**

```bash
bun test test/permission/arity.test.ts
# Expected: all tests passing including new rtk wrapper tests
```
