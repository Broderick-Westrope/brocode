# Per-Message Aggregate Tool Result Budget

> **Status:** DRAFT

## Specification

**Problem:** OpenCode has no aggregate limit on tool results within a single assistant message. When the model issues N parallel tool calls (common in agentic loops -- 3-5 calls per step), each tool result can be up to 50KB after individual truncation. A single turn with 5 parallel calls can inject 250KB (~62K tokens) into context, consuming 25-50% of a 200K context window in one step. This accelerates compaction triggers, wastes tokens on content that will be pruned shortly, and degrades performance.

**Goal:** After this work, each assistant message's aggregate tool result content is capped at a configurable limit (default 200K chars). When exceeded, the largest tool results are persisted to disk and replaced with a short preview + file path. A stable state machine ensures that once a result's replacement decision is made, it never changes -- preserving prompt cache stability. The feature integrates cleanly with the existing pruning system and is transparent to the model (which sees a preview and can use Read/Grep to access the full output).

**Scope:**
- **In scope:** Per-message aggregate budget enforcement, disk persistence with preview, stable state machine for cache coherence, config option, integration into the prompt loop, tests.
- **Out of scope:** Cache-editing API integration (separate feature), output token capping (separate feature), changes to individual tool truncation limits.

**Success Criteria:**

- [ ] Parallel tool calls producing >200K chars aggregate in one message are persisted to disk with previews
- [ ] Replacement decisions are stable across turns (once a result is seen, its fate is frozen)
- [ ] Budget limit is configurable via `opencode.json` under `compaction.budget`
- [ ] Existing pruning (`time.compacted`) and truncation (`Truncate.output`) continue to work unchanged
- [ ] All existing tests pass (`bun test` in `packages/opencode`)
- [ ] New tests cover: under-budget no-op, over-budget replacement, stable state across turns, config override

## Context Loading

_Run before starting:_

```bash
read packages/opencode/src/session/message-v2.ts
read packages/opencode/src/session/prompt.ts
read packages/opencode/src/session/compaction.ts
read packages/opencode/src/tool/truncate.ts
read packages/opencode/src/tool/tool.ts
read packages/opencode/src/config/config.ts
read packages/opencode/src/util/token.ts
read packages/opencode/src/session/index.ts
```

## Tasks

### Budget Module Tasks

#### Task 1: Create the `ToolResultBudget` module

**Context:** `packages/opencode/src/session/`, `packages/opencode/src/tool/truncate.ts`, `packages/opencode/src/util/token.ts`, `packages/opencode/src/session/compaction.ts` (for the Effect pattern to follow)

**Files:**
- Create: `packages/opencode/src/session/budget.ts`
- Test: `packages/opencode/test/session/budget.test.ts`

**Steps:**

1. [ ] Create `packages/opencode/src/session/budget.ts` with the `ToolResultBudget` namespace.

   **Constants:**
   ```typescript
   export const DEFAULT_BUDGET_CHARS = 200_000
   export const PREVIEW_SIZE_BYTES = 2_000
   export const PERSISTED_OUTPUT_TAG = "<persisted-output>"
   export const PERSISTED_OUTPUT_CLOSING_TAG = "</persisted-output>"
   const PROTECTED_TOOLS = ["skill"]
   ```

   **State type** -- the stable state machine:
   ```typescript
   export interface State {
     /** callIDs of tool results we have already made a decision about */
     seen: Set<string>
     /** Map from callID -> replacement string for results that were persisted */
     replacements: Map<string, string>
   }

   export function createState(): State {
     return { seen: new Set(), replacements: new Map() }
   }
   ```

   The three logical states for any tool `callID`:
   - **fresh**: `callID` not in `seen` -- eligible for new budget decisions
   - **frozen**: `callID` in `seen`, NOT in `replacements` -- was seen and left unreplaced; cannot be replaced later (would break prompt cache prefix)
   - **mustReapply**: `callID` in `seen` AND in `replacements` -- was replaced before; the cached replacement string must be re-applied (zero I/O, byte-identical)

   **`preview` function:** Takes a string, returns the first `PREVIEW_SIZE_BYTES` bytes, cutting at a newline boundary if possible (scan backwards from the byte limit, stop at 50% minimum). Returns `{ text: string, hasMore: boolean }`.

   **`format` function:** Takes `{ path: string, size: number, preview: string, hasMore: boolean }` and returns:
   ```
   <persisted-output>
   Output too large (150.0 KB). Full output saved to: /path/to/file

   Preview (first 2.0 KB):
   [preview content]
   ...
   </persisted-output>
   ```

   Use a `formatSize` helper: `(n / 1024).toFixed(1) + " KB"`.

   **`persisted` function:** Returns `true` if a string starts with `PERSISTED_OUTPUT_TAG`. Used to skip double-processing.

   **`enforce` function** -- the core algorithm. This is a plain function (not Effect-based) that receives a session-update callback:

   ```typescript
   export async function enforce(input: {
     messages: MessageV2.WithParts[]
     state: State
     limit?: number
     /** Callback to persist a modified part to storage */
     persist: (part: MessageV2.ToolPart) => Promise<void>
   }): Promise<void>
   ```

   **Why a callback instead of Session.Service dependency:** The `enforce` function is pure logic + file I/O. By accepting a `persist` callback, it stays testable without requiring the full Effect layer, and the prompt loop can pass `(part) => Effect.runPromise(sessions.updatePart(part))` from its already-yielded `sessions` service. This matches the project's preference for keeping functions composable and simple.

   Algorithm for `enforce`:
   1. Group completed tool parts by their parent `messageID` (each assistant message is one group).
   2. For each assistant message group:
      a. Collect candidates: completed tool parts where `!time.compacted` and output is not empty and not `persisted(output)` and tool name is not in `PROTECTED_TOOLS`.
      b. Partition candidates into `{ mustReapply, frozen, fresh }` by checking `state.seen` and `state.replacements`.
      c. **mustReapply**: If the part's current `state.output` differs from the cached replacement in `state.replacements`, set `state.output` to the cached value and call `persist(part)`. Otherwise no-op.
      d. **frozen**: Leave untouched. Accumulate `output.length` into `frozenSize`.
      e. **fresh**: Compute `freshSize` = sum of all fresh output lengths. If `frozenSize + freshSize > limit`:
         - Sort fresh by `output.length` descending
         - Greedily select the largest for replacement until `frozenSize + remainingFreshSize <= limit`
         - For each selected:
           1. Sanitize `callID` for use as filename: replace any non-alphanumeric/dash/underscore chars with `_` (defense against MCP-sourced callIDs with unexpected characters).
           2. Compute `filepath = path.join(TRUNCATION_DIR, sanitized + ".txt")`.
           3. Write full output to `filepath` using `Bun.write(filepath, output)`. If the file already exists (from a prior run), skip the write -- the content is deterministic per callID.
           4. Generate preview via `preview(output)`.
           5. Build replacement string via `format({ path: filepath, size: output.length, ... })`.
           6. Set `part.state.output = replacement`.
           7. Set `part.state.time.compacted = Date.now()` -- this ensures that even after the disk file is cleaned up (7-day retention), `toModelMessages` will render `"[Old tool result content cleared]"` instead of a stale file path.
           8. Record `state.replacements.set(callID, replacement)`.
           9. Call `persist(part)`.
      f. Mark ALL fresh candidate `callID`s in `state.seen` (both replaced and not replaced -- freezing their fate for future turns).

   **Critical: setting `time.compacted` on budget-replaced parts.** This is the safety net for stale file paths. After the TRUNCATION_DIR cleanup removes the file (7 days), the `toModelMessages` code at `message-v2.ts:718` checks `time.compacted` first and replaces output with `"[Old tool result content cleared]"`. Without this, the model would see a `<persisted-output>` message pointing to a deleted file.

   **Note on `mustReapply` and `time.compacted`:** For `mustReapply` parts, `time.compacted` is already set from the original replacement. The cached replacement string in `state.replacements` still includes the `<persisted-output>` wrapper. But since `toModelMessages` checks `time.compacted` FIRST (line 718: `part.state.time.compacted ? "[Old tool result content cleared]" : part.state.output`), the persisted output string is only used within the same session/runLoop invocation. On resume (new `runLoop`, fresh `State`), the `time.compacted` flag takes over and renders the safe cleared message. This means the `mustReapply` path provides a richer message (with preview) during the current session, while the `time.compacted` path provides the safe fallback for future sessions.

2. [ ] Create `packages/opencode/test/session/budget.test.ts` with the following test cases:

   - **Under budget, no-op:** 3 tool results totaling 100K chars -> no parts modified, all callIDs in `state.seen`, none in `state.replacements`.
   - **Over budget, replaces largest:** 5 tool results totaling 300K chars (sizes: 80K, 70K, 60K, 50K, 40K) with limit 200K -> the 80K and 70K results are persisted. Their output starts with `<persisted-output>`. Their `time.compacted` is set. The 60K+50K+40K results are unchanged. Files exist on disk.
   - **Stable state -- frozen results untouched on re-run:** First call freezes 3 results (under budget). Second call adds 2 fresh results that push over budget. Only the fresh results are considered for replacement; the frozen originals are never modified.
   - **mustReapply -- re-applies cached replacements:** After a result is replaced, reset its `state.output` to something different (simulating a hypothetical code path). Call `enforce` again. The `mustReapply` path restores the cached replacement string and calls `persist`.
   - **Already-compacted parts skipped:** Parts with `time.compacted` already set are excluded from budget calculation entirely.
   - **Already-persisted output skipped:** Parts whose output starts with `<persisted-output>` are excluded.
   - **Empty output skipped:** Parts with empty string output are excluded.
   - **Configurable limit:** Passing `limit: 100_000` triggers replacement at a lower threshold.
   - **Preview generation:** Preview cuts at newline boundary within PREVIEW_SIZE_BYTES. Test with multi-line content and single-line content.
   - **Skill tool skipped:** Parts where `tool === "skill"` are excluded even if large.
   - **callID sanitization:** A callID containing `/` and `..` is sanitized to safe filename characters.

   Use the `tmpdir` fixture from `test/fixture/fixture.ts` for file I/O tests. Set `TRUNCATION_DIR` appropriately for the test environment (you may need to mock or override the import).

   For the `persist` callback in tests, use a simple mock that tracks which parts were persisted:
   ```typescript
   const persisted: MessageV2.ToolPart[] = []
   const persist = async (part: MessageV2.ToolPart) => { persisted.push(structuredClone(part)) }
   ```

   Build test message structures following the patterns in `test/session/compaction.test.ts` (the `user()` and `assistant()` helpers, `createModel()` function).

**Verify:**
```bash
cd packages/opencode && bun test test/session/budget.test.ts
```

### Integration Tasks

#### Task 2: Add config option and integrate into the prompt loop

**Context:** `packages/opencode/src/config/config.ts`, `packages/opencode/src/session/prompt.ts`, `packages/opencode/src/session/budget.ts`

**Files:**
- Modify: `packages/opencode/src/config/config.ts` (add `budget` field to `compaction` schema)
- Modify: `packages/opencode/src/session/prompt.ts` (create state, call `enforce` before `toModelMessages`)

**Steps:**

1. [ ] In `packages/opencode/src/config/config.ts`, add a `budget` field to the `compaction` schema object (around line 1006-1017). Insert it after the `prune` field:

   ```typescript
   compaction: z
     .object({
       auto: z.boolean().optional().describe("Enable automatic compaction when context is full (default: true)"),
       prune: z.boolean().optional().describe("Enable pruning of old tool outputs (default: true)"),
       budget: z
         .number()
         .int()
         .min(0)
         .optional()
         .describe(
           "Per-message aggregate tool result character budget. When parallel tool results in a single message exceed this limit, the largest are persisted to disk. Set to 0 to disable. (default: 200000)",
         ),
       reserved: z
         .number()
         .int()
         .min(0)
         .optional()
         .describe("Token buffer for compaction. Leaves enough window to avoid overflow during compaction."),
     })
     .optional(),
   ```

2. [ ] In `packages/opencode/src/session/prompt.ts`, add an import for `ToolResultBudget` at the top:
   ```typescript
   import { ToolResultBudget } from "./budget"
   ```

3. [ ] In `packages/opencode/src/session/prompt.ts`, in the `runLoop` function (line 1337), create the budget state once after `let step = 0` and `const session = ...` (around line 1342):
   ```typescript
   const budgetState = ToolResultBudget.createState()
   ```

   Also read the config once, before the `while(true)` loop (hoist outside the loop to avoid re-reading on every iteration):
   ```typescript
   const cfg = yield* Effect.promise(() => Config.get())
   const budgetLimit = cfg.compaction?.budget
   ```

4. [ ] In `packages/opencode/src/session/prompt.ts`, before the `Effect.all` block that calls `toModelMessages` (around line 1501), after the plugin trigger on messages (line 1499), add budget enforcement:

   ```typescript
   // Enforce per-message aggregate tool result budget.
   // Runs before toModelMessages so the model sees persisted previews.
   // State is session-scoped so replacement decisions are stable across steps.
   if (budgetLimit !== 0) {
     yield* Effect.promise(() =>
       ToolResultBudget.enforce({
         messages: msgs,
         state: budgetState,
         limit: budgetLimit ?? ToolResultBudget.DEFAULT_BUDGET_CHARS,
         persist: (part) => Effect.runPromise(sessions.updatePart(part)),
       }),
     )
   }
   ```

   This placement ensures:
   - Budget enforcement runs **after** compaction handling (lines 1400-1419) so we don't waste effort on messages about to be compacted.
   - Budget enforcement runs **after** insertReminders (line 1431) and plugin transforms (line 1499) so we process the final message set.
   - Budget enforcement runs **before** `toModelMessages` (line 1505) so the model receives the persisted previews.
   - The `budgetState` lives for the entire `runLoop` call (one user request), preserving frozen/mustReapply decisions across steps.

   **Note on `Effect.runPromise` inside `Effect.promise`:** The `persist` callback bridges from the async `enforce` function back into the Effect runtime. Since `sessions.updatePart` is available from the prompt layer's yielded `Session.Service`, and `Effect.runPromise` will use the current runtime, this is safe. The alternative of making `enforce` fully Effect-based was considered but rejected for testability -- the callback pattern keeps the budget module's tests simple (no Effect layer setup needed).

**Verify:**
```bash
cd packages/opencode && bun test test/session/budget.test.ts
cd packages/opencode && bun typecheck
```

#### Task 3: Run full test suite and fix any issues

**Context:** `packages/opencode/test/`, `packages/opencode/src/session/`

**Files:**
- Potentially modify: any files where existing tests break due to the new integration

**Steps:**

1. [ ] Run the full test suite:
   ```bash
   cd packages/opencode && bun test
   ```

2. [ ] Run the type checker:
   ```bash
   cd packages/opencode && bun typecheck
   ```

3. [ ] If any existing tests fail, investigate and fix. Likely areas:
   - Tests that mock the prompt loop may need the `budgetState` variable
   - Tests that create tool parts with specific output content may need updates if the budget alters them
   - Compaction tests that count token sizes may see different numbers if budget fires first

4. [ ] Verify the budget tests still pass after any fixes:
   ```bash
   cd packages/opencode && bun test test/session/budget.test.ts
   ```

**Verify:**
```bash
cd packages/opencode && bun test
cd packages/opencode && bun typecheck
# Expected: all tests pass, zero type errors
```

---

## Design Notes

### Why mutate parts in-place + persist to SQLite?

OpenCode's architecture stores all state in SQLite via `Session.updatePart()`. The `toModelMessages()` function reads from the part's `state.output` field. By mutating the output and persisting it, the budget replacement is:
- **Durable** -- survives session resume (no separate state file needed)
- **Transparent** -- `toModelMessages()` picks up the change automatically
- **Compatible with pruning** -- the `time.compacted` flag ensures safe fallback after disk file cleanup

This differs from Claude Code which replaces content at API-call time (in-memory only, with transcript records for resume). OpenCode's approach is simpler because parts are already persisted to SQLite and mutations are the standard pattern.

### Why set `time.compacted` on budget-replaced parts?

This is the safety net for stale file paths. The sequence is:
1. Budget replaces output with `<persisted-output>` message containing a file path
2. Budget sets `time.compacted = Date.now()`
3. During the CURRENT `runLoop`, `toModelMessages` sees `time.compacted` but the `mustReapply` path ensures the richer `<persisted-output>` preview is used
4. On a FUTURE session resume (new `runLoop`, fresh `State`), `toModelMessages` sees `time.compacted` and renders `"[Old tool result content cleared]"` -- safe regardless of whether the disk file still exists

Without `time.compacted`, a deleted disk file would leave a stale path in the model's context. The 7-day TRUNCATION_DIR cleanup would create this scenario for long-lived sessions.

### Why the state machine?

Without stable decisions, a result that was inline in turn N could be replaced in turn N+1 (because a new large result pushed the total over budget). This would change the bytes in the prompt prefix, invalidating any provider-side prompt cache.

The state machine ensures: once a `callID` is seen, it is either `frozen` (never replace) or `mustReapply` (always replace with the same string). This preserves byte-identical prefixes across turns.

### Why chars instead of tokens?

The budget uses character count (`output.length`) rather than token estimation (`Token.estimate(output)`) for three reasons:
1. **Consistency with Claude Code** which uses the same approach (`MAX_TOOL_RESULTS_PER_MESSAGE_CHARS`)
2. **Speed** -- `output.length` is O(1) vs token estimation which is O(n)
3. **Predictability** -- the relationship between chars and tokens varies by content type (code vs prose vs JSON). A char-based budget is simpler to reason about. At the default 200K chars, this corresponds to roughly 50-67K tokens depending on content.

### State lifetime and session resume

The `ToolResultBudget.State` lives for one `runLoop` invocation. When the user sends a new message, `runLoop` is called again with a fresh state.

**First step of a new `runLoop`:** All existing tool parts are scanned. Parts whose output was previously budget-replaced have `time.compacted` set, so `toModelMessages` renders them as `"[Old tool result content cleared]"`. The budget's `enforce` function sees `time.compacted` and skips them. No reconstruction needed.

**Within a multi-step `runLoop`:** Steps 2+ see the `callID`s from step 1 as `frozen` or `mustReapply` in the state machine. New tool results from step 2 are `fresh` and evaluated against the budget. This preserves cache stability within one invocation.

### Interaction with existing systems

| System | Interaction |
|--------|------------|
| **Individual truncation** (`Truncate.output`) | Runs first (at tool execution time, `tool.ts:77`). Budget runs later (at prompt loop time). They compose: truncation caps individual results at 50KB, budget caps the aggregate. |
| **Pruning** (`compaction.prune`) | Runs after the loop exits (`prompt.ts:1563`). Budget skips parts with `time.compacted`. Both set `time.compacted` but for different reasons -- they don't conflict because budget-replaced parts are already skipped by the pruning walk (`compaction.ts:118`: `if (part.state.time.compacted) break loop`). |
| **Compaction** (`compaction.process`) | Runs when context overflows. Budget runs before `toModelMessages` on each step. If compaction triggers, the next iteration re-gathers messages and budget re-evaluates fresh state. |
| **toModelMessages** | Reads `part.state.output` directly. Parts where `time.compacted` is set render as `"[Old tool result content cleared]"` (`message-v2.ts:718`). No changes needed. |

---

## Review Notes

Devil's advocate review caught:
1. **Effect/async mismatch** -- resolved by using a `persist` callback that bridges from async back to Effect, keeping the module testable without Effect layer setup.
2. **Stale file path after 7-day cleanup** -- resolved by setting `time.compacted` on budget-replaced parts, ensuring `toModelMessages` falls back to the safe cleared message.
3. **`Bun.write` vs `AppFileSystem`** -- using `Bun.write` directly since the budget module is not Effect-based and `Bun.write` is the project's standard for non-Effect file I/O (per AGENTS.md: "Use Bun APIs when possible").
4. **Config read inside loop** -- resolved by hoisting `Config.get()` outside the `while(true)` loop.
5. **callID sanitization** -- added sanitization step for MCP-sourced callIDs that may contain unsafe path characters.
6. **Subtask tool results** -- subtasks run via `handleSubtask` which creates tool parts on a different session (the child). Budget enforcement on the parent session won't see them, which is correct behavior since subtask results are summarized before being returned to the parent.
