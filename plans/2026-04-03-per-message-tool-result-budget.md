# Per-Message Aggregate Tool Result Budget

> **Status:** DRAFT

## Specification

**Problem:** OpenCode has no aggregate limit on tool results within a single assistant message. When the model issues N parallel tool calls (common in agentic loops -- 3-5 calls per step), each tool result can be up to 50KB after individual truncation. A single turn with 5 parallel calls can inject 250KB (~62K tokens) into context, consuming 25-50% of a 200K context window in one step. This accelerates compaction triggers, wastes tokens on content that will be pruned shortly, and degrades performance.

**Goal:** A multi-layered system that minimizes token waste from tool results:

1. **Head+tail preview** (always on) -- when a result is replaced, the preview shows the first 1KB + last 1KB instead of only the first 2KB, capturing both the opening context and the important trailing information (test summaries, error messages, exit codes).
2. **LLM summarization** (opt-in) -- when enabled, over-budget results are summarized by a fast model (Haiku, GPT-4o-mini) before being replaced, preserving semantic meaning rather than arbitrary byte windows.
3. **RTK companion** (recommended, external) -- document RTK as a recommended companion tool that compresses Bash tool output at execution time, reducing the aggregate budget pressure by 60-90% for shell commands.
4. **Aggregate budget cap** (always on) -- the hard ceiling. After layers 1-3, if the aggregate still exceeds the limit, the largest results get replaced with their preview + disk path.

A stable state machine ensures that once a result's replacement decision is made, it never changes -- preserving prompt cache stability.

**Scope:**
- **In scope:** Per-message aggregate budget enforcement, head+tail preview, optional LLM summarization, disk persistence, stable state machine, config options, integration into the prompt loop, RTK documentation, tests.
- **Out of scope:** Cache-editing API integration (separate feature), output token capping (separate feature), changes to individual tool truncation limits, vendoring RTK's structured extraction logic.

**Success Criteria:**

- [ ] Parallel tool calls producing >200K chars aggregate in one message are persisted to disk with head+tail previews
- [ ] When `compaction.summarize` is enabled, over-budget results are summarized by the small model before replacement
- [ ] Replacement decisions are stable across turns (once a result is seen, its fate is frozen)
- [ ] Budget limit is configurable via `opencode.json` under `compaction.budget`
- [ ] Existing pruning (`time.compacted`) and truncation (`Truncate.output`) continue to work unchanged
- [ ] All existing tests pass (`bun test` in `packages/opencode`)
- [ ] New tests cover: under-budget no-op, over-budget replacement, head+tail preview, LLM summarization path, stable state across turns, config override

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
read packages/opencode/src/provider/provider.ts  # getSmallModel at line 1509
read packages/opencode/src/agent/agent.ts         # compaction agent model resolution pattern
```

## Tasks

### Budget Module Tasks

#### Task 1: Create the `ToolResultBudget` module with head+tail preview

**Context:** `packages/opencode/src/session/`, `packages/opencode/src/tool/truncate.ts`, `packages/opencode/src/util/token.ts`, `packages/opencode/src/session/compaction.ts` (for Effect patterns)

**Files:**
- Create: `packages/opencode/src/session/budget.ts`
- Test: `packages/opencode/test/session/budget.test.ts`

**Steps:**

1. [ ] Create `packages/opencode/src/session/budget.ts` with the `ToolResultBudget` namespace.

   **Constants:**
   ```typescript
   export const DEFAULT_BUDGET_CHARS = 200_000
   export const PREVIEW_BYTES = 1_000  // 1KB head + 1KB tail = 2KB total
   export const PERSISTED_TAG = "<persisted-output>"
   export const PERSISTED_CLOSE = "</persisted-output>"
   const PROTECTED = ["skill"]
   ```

   **State type** -- the stable state machine:
   ```typescript
   export interface State {
     /** callIDs we have already made a decision about */
     seen: Set<string>
     /** callID -> replacement string for persisted results */
     replacements: Map<string, string>
   }

   export function createState(): State {
     return { seen: new Set(), replacements: new Map() }
   }
   ```

   The three logical states for any tool `callID`:
   - **fresh**: `callID` not in `seen` -- eligible for new budget decisions
   - **frozen**: `callID` in `seen`, NOT in `replacements` -- left unreplaced, cannot be replaced later (would break prompt cache prefix)
   - **mustReapply**: `callID` in `seen` AND in `replacements` -- cached replacement re-applied (zero I/O, byte-identical)

   **`preview` function** -- head+tail strategy:
   ```typescript
   export function preview(text: string): { head: string, tail: string, hasMore: boolean }
   ```
   - Returns the first `PREVIEW_BYTES` bytes (cutting at a newline boundary, scanning backwards from the byte limit, min 50%) as `head`.
   - Returns the last `PREVIEW_BYTES` bytes (cutting at a newline boundary, scanning forward from the end minus limit, min 50%) as `tail`.
   - If the text fits in `PREVIEW_BYTES * 2`, returns the full text as `head` with empty `tail` and `hasMore: false`.
   - This captures both the opening context (command being run, file headers, first results) and the trailing context (test pass/fail summary, exit codes, error messages, totals).

   **`format` function:**
   ```typescript
   export function format(input: {
     path: string
     size: number
     head: string
     tail: string
     hasMore: boolean
     summary?: string
   }): string
   ```
   Returns:
   ```
   <persisted-output>
   Output too large (150.0 KB). Full output saved to: /path/to/file

   [Summary:
   <LLM-generated summary if available>
   ]
   Preview (head):
   [first ~1KB]
   ...
   Preview (tail):
   [last ~1KB]
   </persisted-output>
   ```
   When `summary` is provided, it appears between the file path line and the preview sections. When absent, the summary section is omitted entirely. Use a `formatSize` helper: `(n / 1024).toFixed(1) + " KB"`.

   **`persisted` function:** Returns `true` if a string starts with `PERSISTED_TAG`.

   **`enforce` function** -- the core algorithm:
   ```typescript
   export async function enforce(input: {
     messages: MessageV2.WithParts[]
     state: State
     limit?: number
     persist: (part: MessageV2.ToolPart) => Promise<void>
     /** Optional: summarize a tool result using a fast model. Return undefined to skip. */
     summarize?: (output: string, tool: string) => Promise<string | undefined>
   }): Promise<void>
   ```

   **Why a callback instead of Session.Service dependency:** The `enforce` function is pure logic + file I/O. By accepting a `persist` callback, it stays testable without requiring the full Effect layer, and the prompt loop can pass `(part) => Effect.runPromise(sessions.updatePart(part))` from its already-yielded `sessions` service.

   **The `summarize` callback** is optional. When provided, it is called for each result selected for replacement BEFORE building the format string. If it returns a string, that string is included as the `summary` field in `format()`. If it returns `undefined` (or throws), the result falls back to head+tail preview only. This keeps the budget module decoupled from the LLM provider system.

   Algorithm for `enforce`:
   1. Group completed tool parts by their parent `messageID` (each assistant message is one group).
   2. For each assistant message group:
      a. Collect candidates: completed tool parts where `!time.compacted` and output is not empty and not `persisted(output)` and tool name is not in `PROTECTED`.
      b. Partition candidates into `{ mustReapply, frozen, fresh }` by checking `state.seen` and `state.replacements`.
      c. **mustReapply**: If the part's current `state.output` differs from the cached replacement in `state.replacements`, set `state.output` to the cached value and call `persist(part)`. Otherwise no-op.
      d. **frozen**: Leave untouched. Accumulate `output.length` into `frozenSize`.
      e. **fresh**: Compute `freshSize` = sum of all fresh output lengths. If `frozenSize + freshSize > limit`:
         - Sort fresh by `output.length` descending
         - Greedily select the largest for replacement until `frozenSize + remainingFreshSize <= limit`
         - **Summarize in parallel** (if `summarize` callback provided): Call `Promise.all(selected.map(c => summarize(c.output, c.tool).catch(() => undefined)))`. This runs all summarizations concurrently (~500ms total regardless of count, vs N*500ms sequential). Each call is individually caught -- failures yield `undefined` (fallback to preview-only).
         - For each selected (with its summary result):
           1. Sanitize `callID` for use as filename: replace any non-alphanumeric/dash/underscore chars with `_`.
           2. Compute `filepath = path.join(TRUNCATION_DIR, sanitized + ".txt")`.
           3. Write full output to `filepath` using `Bun.write(filepath, output)`. If the file already exists, skip.
           4. Generate head+tail preview via `preview(output)`.
           5. Build replacement string via `format({ path: filepath, size: output.length, head, tail, hasMore, summary })` where `summary` is the parallel summarization result (or `undefined`).
           6. Set `part.state.output = replacement`.
           7. Set `part.state.time.compacted = Date.now()` -- safety net for stale file paths after 7-day disk cleanup.
           8. Record `state.replacements.set(callID, replacement)`.
           9. Call `persist(part)`.
      f. Mark ALL fresh candidate `callID`s in `state.seen` (both replaced and not replaced).

   **Critical: setting `time.compacted` on budget-replaced parts.** After the TRUNCATION_DIR cleanup removes the file (7 days), `toModelMessages` at `message-v2.ts:718` checks `time.compacted` first and renders `"[Old tool result content cleared]"`. This prevents stale file paths.

   **Note on `mustReapply` and `time.compacted`:** For `mustReapply` parts, `time.compacted` is already set from the original replacement. During the current `runLoop`, the `mustReapply` path provides the richer `<persisted-output>` preview (with summary). On resume (new `runLoop`, fresh `State`), `time.compacted` takes over and renders the safe cleared message.

2. [ ] Create `packages/opencode/test/session/budget.test.ts` with the following test cases:

   - **Under budget, no-op:** 3 tool results totaling 100K chars -> no parts modified, all callIDs in `state.seen`, none in `state.replacements`.
   - **Over budget, replaces largest with head+tail preview:** 5 tool results totaling 300K chars (sizes: 80K, 70K, 60K, 50K, 40K) with limit 200K -> the 80K and 70K are persisted. Their output starts with `<persisted-output>` and contains both "Preview (head):" and "Preview (tail):" sections. Their `time.compacted` is set. Files exist on disk.
   - **Head+tail preview content:** A 10KB result with known first and last lines. After replacement, the head section contains the first line and the tail section contains the last line.
   - **Small result preview returns full text:** A 1.5KB result (under 2*PREVIEW_BYTES) returns the full text as head with no tail section.
   - **Stable state -- frozen results untouched on re-run:** First call freezes 3 results (under budget). Second call adds 2 fresh results that push over budget. Only fresh results are considered.
   - **mustReapply -- re-applies cached replacements.**
   - **Already-compacted parts skipped.**
   - **Already-persisted output skipped.**
   - **Empty output skipped.**
   - **Configurable limit:** `limit: 100_000` triggers at lower threshold.
   - **Skill tool skipped.**
   - **callID sanitization:** `callID` containing `/` and `..` produces safe filename.
   - **Summarize callback -- included in output:** When `summarize` returns a string, the format output contains `Summary:` section.
   - **Summarize callback -- failure fallback:** When `summarize` throws, the result still gets a head+tail preview without a summary (no error propagated).
   - **Summarize callback -- undefined means skip:** When `summarize` returns undefined, no summary section in output.

   For the `persist` and `summarize` callbacks in tests, use simple mocks:
   ```typescript
   const persisted: MessageV2.ToolPart[] = []
   const persist = async (part: MessageV2.ToolPart) => { persisted.push(structuredClone(part)) }
   const summarize = async (output: string) => `Summary of ${output.length} chars`
   ```

   Build test message structures following the patterns in `test/session/compaction.test.ts`.

**Verify:**
```bash
cd packages/opencode && bun test test/session/budget.test.ts
```

### Integration Tasks

#### Task 2: Add config options and integrate into the prompt loop

**Context:** `packages/opencode/src/config/config.ts`, `packages/opencode/src/session/prompt.ts`, `packages/opencode/src/session/budget.ts`, `packages/opencode/src/provider/provider.ts` (`getSmallModel` at line 1509)

**Files:**
- Modify: `packages/opencode/src/config/config.ts` (add `budget` and `summarize` fields to `compaction` schema)
- Modify: `packages/opencode/src/session/prompt.ts` (create state, wire up summarize callback, call `enforce`)

**Steps:**

1. [ ] In `packages/opencode/src/config/config.ts`, add `budget` and `summarize` fields to the `compaction` schema object (around line 1006-1017). Insert after the `prune` field:

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
       summarize: z
         .boolean()
         .optional()
         .describe(
           "When true, over-budget tool results are summarized by the small model (Haiku/GPT-4o-mini) before replacement. Adds ~300-500ms latency per summarized result but preserves semantic meaning. (default: false)",
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

2. [ ] In `packages/opencode/src/session/prompt.ts`, add imports:
   ```typescript
   import { ToolResultBudget } from "./budget"
   ```

3. [ ] In `packages/opencode/src/session/prompt.ts`, in the `runLoop` function (line 1337), after `let step = 0` and `const session = ...` (around line 1342), create budget state and read config (hoisted outside `while(true)`):
   ```typescript
   const budgetState = ToolResultBudget.createState()
   const cfg = yield* Effect.promise(() => Config.get())
   const budgetLimit = cfg.compaction?.budget
   const budgetSummarize = cfg.compaction?.summarize === true
   ```

4. [ ] In `packages/opencode/src/session/prompt.ts`, before the `Effect.all` block that calls `toModelMessages` (around line 1501), after the plugin trigger on messages (line 1499), add budget enforcement.

   **Critical: resolve the small model eagerly, outside the callback.** The `summarize` callback is an `async` function, NOT an Effect generator. You cannot `yield*` inside it. Instead, resolve the small model and its language model once (eagerly) and close over them in the callback:

   ```typescript
   if (budgetLimit !== 0) {
     // Resolve the small model eagerly so the async callback can close over it.
     // Uses static Provider.getSmallModel() and Provider.getLanguage() which
     // handle their own Effect runtimes internally.
     let summarize: ((output: string, tool: string) => Promise<string | undefined>) | undefined
     if (budgetSummarize) {
       const small = await Provider.getSmallModel(model.providerID)
       const language = small ? await Provider.getLanguage(small) : undefined
       if (language) {
         summarize = async (output: string, tool: string) => {
           try {
             const { text } = await generateText({
               model: language,
               maxTokens: 500,
               messages: [{
                 role: "user",
                 content: `Summarize this ${tool} tool output in under 500 tokens. Preserve all file paths, error messages, test results (pass/fail counts), key findings, and actionable information. Be concise.\n\n${output}`,
               }],
             })
             return text
           } catch {
             return undefined
           }
         }
       }
     }

     yield* Effect.promise(() =>
       ToolResultBudget.enforce({
         messages: msgs,
         state: budgetState,
         limit: budgetLimit ?? ToolResultBudget.DEFAULT_BUDGET_CHARS,
         persist: (part) => Effect.runPromise(sessions.updatePart(part)),
         summarize,
       }),
     )
   }
   ```

   **Why eager resolution:** `Provider.getSmallModel()` (line 1630) and `Provider.getLanguage()` (line 1622) are static `async` functions that wrap their own Effect runtime via `runPromise`. They can be `await`ed inside the Effect generator's `Effect.promise` blocks. By resolving once before defining the callback, we avoid the `yield*`-inside-async problem entirely. If no small model is available (returns `undefined`), `summarize` stays `undefined` and the budget falls back to head+tail preview only.

   **`generateText` import:** Import from the `ai` package (already a dependency) at the top of `prompt.ts`. This is an intentional bypass of `LLM.stream` wrapping -- the summarization call is a fast internal helper that doesn't need telemetry, plugin hooks, or provider transforms. Add a comment explaining this.

   **Parallel summarization inside `enforce`:** The `enforce` function should collect all candidates selected for replacement first, then call `Promise.all(candidates.map(c => summarize(c.output, c.tool)))` to run summarizations in parallel. This avoids compounding latency when multiple results exceed budget (3 results × 500ms sequential = 1.5s vs ~500ms parallel).

   **Latency impact:** Summarization only runs for results that exceed the budget (typically 1-3 per task). Each Haiku call takes ~300-500ms. With parallel execution, overhead per step is ~500ms regardless of count. Total overhead per task: 1-3 seconds, vs 5-30 seconds per main model step.

   **Cost note:** At Haiku's $0.80/M input token pricing, summarizing a 50KB result (~12.5K tokens) costs ~$0.01. For 3 results per task that's ~$0.03. Users should be aware of this -- it's why the feature is opt-in.

   This placement ensures:
   - Budget enforcement runs **after** compaction handling (lines 1400-1419).
   - Budget enforcement runs **before** `toModelMessages` (line 1505).
   - The `budgetState` lives for the entire `runLoop` call.

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

### Documentation Tasks

#### Task 4: Document RTK as a recommended companion

**Context:** `packages/opencode/`, RTK GitHub repo at https://github.com/rtk-ai/rtk

**Files:**
- Create: `packages/opencode/docs/rtk-companion.md`

**Steps:**

1. [ ] Create `packages/opencode/docs/rtk-companion.md` documenting RTK as a recommended companion tool for token optimization. Include:

   - What RTK does: CLI proxy that reduces LLM token consumption by 60-90% on common dev commands (git, test runners, build tools, grep, ls).
   - How it complements the budget system: RTK compresses Bash tool output at execution time (before it enters context). The budget system handles the aggregate across ALL tool types (including Read, Grep, Glob, MCP tools that RTK doesn't touch). Together they provide defense in depth.
   - Installation: `rtk init -g --opencode` (creates an OpenCode plugin that rewrites Bash commands).
   - Link to RTK docs: https://github.com/rtk-ai/rtk
   - Note that RTK only affects Bash tool calls -- OpenCode's native tools (Read, Grep, Glob) bypass RTK, which is why the budget system is still needed.

**Verify:**
```bash
# Verify the file exists and is well-formed markdown
cat packages/opencode/docs/rtk-companion.md
```

---

## Design Notes

### Architecture: four layers of defense

```
Layer 1: RTK (external, optional)
  Compresses Bash tool output at execution time.
  60-90% reduction for shell commands.
  Does NOT affect Read/Grep/Glob/MCP tools.
        |
        v
Layer 2: Individual truncation (Truncate.output)
  Caps each tool result at 2000 lines / 50KB.
  Runs at tool execution time in tool.ts:77.
        |
        v
Layer 3: LLM summarization (opt-in)
  When compaction.summarize=true, over-budget results
  are summarized by the small model before replacement.
  ~300-500ms per result, ~$0.003 per result.
        |
        v
Layer 4: Aggregate budget cap (always on)
  Per-message aggregate limit (default 200K chars).
  Largest results replaced with head+tail preview + disk path.
  Stable state machine preserves prompt cache.
```

Layers 1-3 reduce the pressure on Layer 4. With all layers active, the budget cap rarely triggers. But it's always there as the hard ceiling.

### Why head+tail instead of head-only?

Tool outputs frequently have important information at the end:
- **Test runners:** pass/fail summary, total counts, timing
- **Build tools:** success/failure status, output paths
- **Git operations:** push results, merge status
- **Grep:** the last few matches may be in the most relevant files

A head-only preview misses all of this. Head+tail (1KB each) captures both the context-setting opening and the results-summarizing closing at the same total preview size (2KB).

### Why LLM summarization is opt-in (not default)

1. **Adds external dependency:** Requires a working small model (Haiku, GPT-4o-mini). Not all providers have one.
2. **Adds latency:** ~300-500ms per summarized result. Acceptable but nonzero.
3. **Adds cost:** ~$0.003 per result. Negligible but nonzero.
4. **Can fail:** Model errors, rate limits, provider outages. Must never block the budget.
5. **Can be wrong:** The summary might miss important details the model needs.

For users who want maximum information density and accept the tradeoffs, `compaction.summarize: true` enables it. The head+tail preview provides a good baseline without it.

### Why mutate parts in-place + persist to SQLite?

OpenCode's architecture stores all state in SQLite via `Session.updatePart()`. The `toModelMessages()` function reads from `part.state.output`. By mutating the output and persisting it, the budget replacement is:
- **Durable** -- survives session resume (no separate state file needed)
- **Transparent** -- `toModelMessages()` picks up the change automatically
- **Compatible with pruning** -- `time.compacted` flag ensures safe fallback after disk file cleanup

### Why set `time.compacted` on budget-replaced parts?

Safety net for stale file paths. The sequence:
1. Budget replaces output with `<persisted-output>` message containing a file path
2. Budget sets `time.compacted = Date.now()`
3. During the CURRENT `runLoop`, `mustReapply` ensures the richer preview is used
4. On FUTURE session resume (fresh `State`), `toModelMessages` sees `time.compacted` and renders `"[Old tool result content cleared]"` -- safe regardless of disk file state

### Why the state machine?

Without stable decisions, a result inline in turn N could be replaced in turn N+1 (new large result pushes over budget). This changes bytes in the prompt prefix, invalidating provider-side prompt cache.

The state machine ensures: once a `callID` is seen, its fate (frozen or replaced) never changes. Byte-identical prefixes across turns.

### Why chars instead of tokens?

1. **Consistency with Claude Code** (`MAX_TOOL_RESULTS_PER_MESSAGE_CHARS`)
2. **Speed** -- `output.length` is O(1) vs token estimation O(n)
3. **Predictability** -- 200K chars ≈ 50-67K tokens depending on content

### Interaction with existing systems

| System | Interaction |
|--------|------------|
| **RTK** (external) | Compresses Bash output at execution time. Budget handles everything else. Complementary. |
| **Individual truncation** (`Truncate.output`) | Runs first (tool execution time, `tool.ts:77`). Budget runs later (prompt loop time). Truncation caps individual results, budget caps aggregate. |
| **Pruning** (`compaction.prune`) | Runs after loop exits (`prompt.ts:1563`). Budget skips `time.compacted` parts. Both set `time.compacted` -- no conflict because budget-replaced parts are skipped by the prune walk (`compaction.ts:118`). |
| **Compaction** (`compaction.process`) | Runs on context overflow. Budget runs before `toModelMessages` each step. If compaction triggers, next iteration re-gathers messages and budget re-evaluates fresh state. |
| **toModelMessages** | Reads `part.state.output` directly. `time.compacted` parts render as `"[Old tool result content cleared]"` (`message-v2.ts:718`). No changes needed. |

### Summarization prompt design

The summarization prompt is deliberately minimal:
```
Summarize this {tool} tool output in under 500 tokens. Preserve all file paths,
error messages, test results (pass/fail counts), key findings, and actionable
information. Be concise.
```

By including the tool name, the small model can apply domain-appropriate summarization (e.g., for `bash` tool output from test runners, it knows to preserve pass/fail counts). The 500-token cap keeps the summary compact -- the goal is information density, not completeness.

### State lifetime and session resume

The `ToolResultBudget.State` lives for one `runLoop` invocation.

**First step of a new `runLoop`:** Parts whose output was previously budget-replaced have `time.compacted` set, so `toModelMessages` renders them as `"[Old tool result content cleared]"`. The budget's `enforce` function sees `time.compacted` and skips them. No reconstruction needed.

**Within a multi-step `runLoop`:** Steps 2+ see prior `callID`s as `frozen` or `mustReapply`. New tool results are `fresh`. Cache stability preserved.

---

## Review Notes

Devil's advocate review of the original plan caught:
1. **Effect/async mismatch** -- resolved by using `persist` and `summarize` callbacks that bridge from async to Effect.
2. **Stale file path after 7-day cleanup** -- resolved by setting `time.compacted` on budget-replaced parts.
3. **`Bun.write` vs `AppFileSystem`** -- using `Bun.write` directly (budget module is not Effect-based, per AGENTS.md: "Use Bun APIs when possible").
4. **Config read inside loop** -- resolved by hoisting outside `while(true)`.
5. **callID sanitization** -- added for MCP-sourced callIDs.
6. **Subtask tool results** -- correctly excluded (run on child session).

Second review (after adding summarization) caught:
7. **`yield*` inside async closure** -- critical syntax error. Resolved by eagerly resolving the small model and language model via static `Provider.getSmallModel()` / `Provider.getLanguage()` before defining the callback.
8. **`generateText` placeholder** -- filled in with concrete model resolution. Added comment that this intentionally bypasses `LLM.stream` wrappers (fast internal helper).
9. **Sequential summarization latency** -- resolved by using `Promise.all` for parallel summarization inside `enforce`.
10. **Cost clarification** -- updated from $0.003 to ~$0.01 per result at Haiku's actual pricing. Documented total cost impact.

Additional design decisions from brainstorming:
11. **Head+tail preview** -- captures trailing information (test summaries, exit codes) that head-only misses.
12. **LLM summarization** -- opt-in via `compaction.summarize`, uses existing `Provider.getSmallModel()` priority chain (Haiku -> Flash -> Nano).
13. **RTK as companion** -- documented as recommended external tool, not vendored. Handles Bash compression at a different layer.
14. **No structured extraction for non-Bash tools** -- only Grep would meaningfully benefit, and head+tail + optional Haiku covers it better with less custom code.
