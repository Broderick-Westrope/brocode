# Address Review Warnings — Implementation Plan

> **Status:** COMPLETED

## Specification

**Problem:** The `feature/aggregate-tool-budget` branch has 7 warnings from code review: silent catch blocks hiding errors, misleading comments, fragile model detection, unnecessary `fs/promises` import, and missing test coverage for new pure functions.

**Goal:** All warnings resolved. Debug logging aids troubleshooting. Comments are accurate. `supportsDefer` handles future model names. New pure functions have unit tests.

**Scope:**

- IN: Fix all 7 warnings from the review
- OUT: The `as any` casts on `jsonSchema()` and tool `id` — these are pre-existing patterns used throughout `prompt.ts` (lines 462, 464, 1942, 1944), not introduced by this branch. Fixing them would be a separate codebase-wide refactor.

**Success Criteria:**

- [ ] All catch blocks in `credentials.ts` have `log.debug` calls (including the `.catch` on line 93)
- [ ] Billing comment in `billing.ts` accurately describes the cch derivation
- [ ] 401 retry in `index.ts` has a comment explaining the single-retry design
- [ ] `credentials.ts` uses `Bun.write` instead of `writeFile` from `fs/promises`; the `fs/promises` import is removed
- [ ] `supportsDefer` matches current and future Sonnet/Opus 4+ models including dot-versioned IDs
- [ ] Unit tests exist for `billing.compute()` and `supportsDefer()` covering real-world model ID formats
- [ ] `bun test` passes from `packages/opencode`

## Context Loading

```bash
read packages/opencode/src/plugin/claude-oauth/credentials.ts
read packages/opencode/src/plugin/claude-oauth/billing.ts
read packages/opencode/src/plugin/claude-oauth/index.ts
read packages/opencode/src/provider/transform.ts:1049-1054
```

## OAuth Plugin Cleanup

### Task 1: Add debug logging to catch blocks, fix comments, switch to Bun.write

**Context:** `src/plugin/claude-oauth/`

**Files:**

- Modify: `src/plugin/claude-oauth/credentials.ts`
- Modify: `src/plugin/claude-oauth/billing.ts`
- Modify: `src/plugin/claude-oauth/index.ts`

**Steps:**

1. [ ] In `credentials.ts`, add `import { Log } from "../../util/log"` and create `const log = Log.create({ service: "plugin.claude-oauth.credentials" })`

2. [ ] In `credentials.ts`, remove the `import { writeFile } from "fs/promises"` import entirely

3. [ ] Add `log.debug` with the error to all catch blocks in `credentials.ts`:
   - Line 51 keychain catch: change from empty `catch {}` to `catch (e) { log.debug("keychain read failed", { error: e }) }`
   - Line 61 file parse catch: `catch (e) { log.debug("credentials file parse failed", { error: e }) }`
   - Line 93 `.catch(() => ({}))` in refresh: change to `.catch((e: unknown) => { log.debug("existing credentials unreadable", { error: e }); return {} })`
   - Line 108 refresh catch: `catch (e) { log.debug("token refresh failed", { error: e }) }`

4. [ ] In `credentials.ts:refresh()` (line 94), replace `writeFile` with `Bun.write`:

   ```typescript
   // Replace:
   await writeFile(file, JSON.stringify({...}), { mode: 0o600 })
   // With:
   await Bun.write(file, JSON.stringify({...}), { mode: 0o600 })
   ```

5. [ ] In `billing.ts`, replace the comment block (lines 1-5) with:

   ```
   // Billing header injected as a system message entry (not an HTTP header).
   // The cch field is intentionally derived from system prompt text rather than
   // user message text — the system.transform hook doesn't have access to
   // messages, so we use the system prompt as the hash input instead.
   ```

6. [ ] In `index.ts`, add a comment before the 401 check (before line 68):
   ```typescript
   // Single retry on 401: refresh credentials and retry once.
   // If the refreshed token also 401s, the response propagates to the caller.
   ```

**Verify:**

```bash
cd packages/opencode && bun typecheck
# Expected: no new errors
```

## Transform Cleanup

### Task 2: Make supportsDefer more future-proof

**Context:** `src/provider/transform.ts`

**Files:**

- Modify: `src/provider/transform.ts`

**Steps:**

1. [ ] Replace the `supportsDefer` function at line 1049-1053 with a version-aware check:
   ```typescript
   export function supportsDefer(model: Provider.Model): boolean {
     if (model.api.npm !== "@ai-sdk/anthropic") return false
     const id = model.api.id.toLowerCase()
     // Tool search requires Sonnet 4+ or Opus 4+ (no Haiku).
     // Matches: claude-sonnet-4-20250514, claude-opus-4.1, claude-opus-4-1, claude-opus-12-...
     const match = id.match(/claude-(?:sonnet|opus)-(\d+)/)
     if (!match) return false
     return parseInt(match[1], 10) >= 4
   }
   ```
   This regex captures the major version number after `sonnet-` or `opus-`. The `\d+` greedily captures only the first integer, so all three ID formats work: `claude-sonnet-4-20250514` → `4`, `claude-opus-4.1` → `4`, `claude-opus-4-1` → `4`, `claude-sonnet-12-20280101` → `12`.

**Verify:**

```bash
cd packages/opencode && bun typecheck
# Expected: no new errors
```

## Tests

### Task 3: Add unit tests for pure functions

**Context:** `test/`, `src/plugin/claude-oauth/billing.ts`, `src/provider/transform.ts`

**Files:**

- Create: `test/plugin/claude-oauth/billing.test.ts`
- Create: `test/provider/transform-defer.test.ts`

**Steps:**

1. [ ] Create `test/plugin/claude-oauth/billing.test.ts` with tests for `billing.compute()`:
   - Test: returns string starting with `x-anthropic-billing-header:`
   - Test: contains expected structural keys (`cc_version=`, `cc_entrypoint=`, `cch=`)
   - Test: deterministic — same inputs produce same output
   - Test: varies when text differs
   - Test: handles empty string input without error
   - Test: handles short string (< 21 chars) where character sampling hits fallback `"0"`
   - Test: handles long string (> 21 chars) where all samples hit real characters

2. [ ] Create `test/provider/transform-defer.test.ts` with tests for `supportsDefer()`:
   - Test: supports `claude-sonnet-4-20250514` (date-suffixed)
   - Test: supports `claude-opus-4-20250514`
   - Test: supports `claude-opus-4.1` (dot-versioned)
   - Test: supports `claude-opus-4-1` (dash-separated minor version)
   - Test: supports `claude-sonnet-4.6`
   - Test: supports future versions: `claude-sonnet-5-20260101`, `claude-opus-12-20280101`
   - Test: rejects `claude-haiku-4-20250514`
   - Test: rejects non-anthropic npm: `@ai-sdk/openai` with `claude-sonnet-4-20250514`
   - Test: rejects older models: `claude-3-5-sonnet-20241022`

   Use a minimal model factory: `const model = (npm: string, id: string) => ({ api: { npm, id } }) as Parameters<typeof ProviderTransform.supportsDefer>[0]` — this casts to the function's parameter type rather than `any`.

**Verify:**

```bash
cd packages/opencode && bun test test/plugin/claude-oauth/billing.test.ts test/provider/transform-defer.test.ts
# Expected: all tests pass
```

---

<!-- Review notes:
Devils advocate review caught:
1. Original catch block logging had empty `{}` instead of capturing the error — fixed to include `{ error: e }`
2. The `.catch(() => ({}))` on line 93 was missed — added to the plan
3. Success criterion mentioned testing `credentials.parse()` which is not exported — removed
4. supportsDefer tests only covered date-suffix format, not dot-versioned IDs that exist in production — added
5. billing tests used exact substring matching — changed to structural assertions
6. billing tests didn't cover empty/short string edge cases — added
7. Test model factory used `as any` — changed to cast to function parameter type
-->
