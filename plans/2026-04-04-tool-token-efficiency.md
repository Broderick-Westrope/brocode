# Tool Token Efficiency

> **Status:** COMPLETED

## Specification

**Problem:** OpenCode sends ~211KB of tool definitions on every API request. The `skill` tool alone is 25KB because it embeds all ~60 skill descriptions in its tool description (duplicating the system prompt). No tool definitions have `cache_control`, so 211KB is re-tokenized every turn. Additionally, the Claude OAuth billing plugin broke system prompt caching by prepending 2 entries that invalidate the collapse guard in `llm.ts`, leaving the 50KB system prompt uncached.

**Goal:** Reduce per-turn token waste from tools and restore system prompt caching. The skill tool description drops from ~25KB to <1KB. Tool definitions get prompt-cached after the first turn (~211KB saved per subsequent turn). The system prompt is always fully cached.

**Scope:**

- **In scope:** Skill tool description reduction, tool-level cache_control for Anthropic, system prompt caching fix, skill info deduplication.
- **Out of scope:** Tool filtering/removal, built-in tool description shortening (bash, todowrite, task), changes to `deferLoading` behavior, non-Anthropic provider caching.

**Success Criteria:**

- [ ] Skill tool description is <1KB (down from ~25KB)
- [ ] Skill descriptions appear only in the system prompt, not duplicated in the tool description
- [ ] Last tool definition has `cache_control: { type: "ephemeral" }` for Anthropic models
- [ ] The last system prompt block has `cacheControl` applied (ensuring the 50KB prompt is cached, not just the first 2 small blocks)
- [ ] Existing tests pass (`bun test` in `packages/opencode`)
- [ ] Type check passes (`bun typecheck` in `packages/opencode`)

## Context Loading

```bash
read packages/opencode/src/tool/skill.ts
read packages/opencode/src/skill/index.ts
read packages/opencode/src/session/prompt.ts        # resolveTools at line 403
read packages/opencode/src/provider/transform.ts     # applyCaching at line 192
read packages/opencode/src/session/llm.ts            # system collapse at line 117
read packages/opencode/src/plugin/claude-oauth/index.ts  # billing prepend at line 115
```

## Tasks

### Tool Token Reduction Tasks

#### Task 1: Reduce skill tool description and deduplicate skill info

**Context:** `packages/opencode/src/tool/skill.ts`, `packages/opencode/src/skill/index.ts`, `packages/opencode/src/session/system.ts`

**Files:**

- Modify: `packages/opencode/src/tool/skill.ts` (replace embedded skill list with names-only reference)

**Steps:**

1. [ ] In `packages/opencode/src/tool/skill.ts`, replace the `description` construction (lines 12-28). Currently it calls `Skill.fmt(list)` which embeds every skill name + description (~25KB). Change it to use `Skill.fmt(list, { compact: true })` which already produces a comma-separated names-only list:

   Replace the description block (lines 12-28) with:

   ```typescript
   const description =
     list.length === 0
       ? "Load a specialized skill that provides domain-specific instructions and workflows. No skills are currently available."
       : [
           "Load a specialized skill that provides domain-specific instructions and workflows.",
           "",
           "When you recognize that a task matches one of the available skills, use this tool to load the full skill instructions.",
           "The skill will inject detailed instructions, workflows, and access to bundled resources (scripts, references, templates) into the conversation context.",
           'Tool output includes a `<skill_content name="...">` block with the loaded content.',
           "",
           "The following skills provide specialized sets of instructions for particular tasks",
           "Invoke this tool to load a skill when a task matches one of the available skills listed below:",
           "",
           "## Available Skills",
           Skill.fmt(list, { compact: true }),
         ].join("\n")
   ```

   This reuses the existing `Skill.fmt` compact mode rather than reimplementing. Skill descriptions remain available in the system prompt via `SystemPrompt.skills()` (called at `prompt.ts:1556`).

   **Note:** When the skill permission is denied for an agent, `SystemPrompt.skills()` returns `undefined` and the skill tool is also filtered out by `registry.tools()`. The names-only approach does NOT create a new gap here — both descriptions would already be absent in that edge case.

2. [ ] Update the `examples` variable (line 30-33) — it still works as-is since it reads from `list`, no change needed. Verify it still compiles.

**Verify:**

```bash
cd packages/opencode && bun typecheck
cd packages/opencode && bun test
```

#### Task 2: Add `cache_control` to the last tool definition for Anthropic

**Context:** `packages/opencode/src/session/prompt.ts` (resolveTools function at line 403), `packages/opencode/src/provider/transform.ts` (supportsDefer)

**Files:**

- Modify: `packages/opencode/src/session/prompt.ts` (add cache breakpoint after all tools are assembled)

**Steps:**

1. [ ] In `packages/opencode/src/session/prompt.ts`, in the `resolveTools` function, after all tools have been assembled but BEFORE `anthropic_tool_search_bm25` is conditionally added (i.e., between the MCP tools loop ending at line 588 and the defer block at line 593), add a cache breakpoint on the last regular tool for Anthropic models.

   Place the cache_control on a regular tool definition rather than the `anthropic_tool_search_bm25` provider tool reference, since `tool_reference` types may not support `cache_control`. Insert this block after line 588 (the closing brace of the MCP tools loop):

   ```typescript
   // Mark the last tool with cache_control so Anthropic's prompt cache
   // recognizes the entire tools block as unchanged between turns.
   if (
     input.model.api.npm === "@ai-sdk/anthropic" ||
     input.model.api.npm === "@ai-sdk/google-vertex/anthropic" ||
     input.model.api.npm === "@ai-sdk/amazon-bedrock"
   ) {
     const keys = Object.keys(tools)
     const last = keys[keys.length - 1]
     if (last) {
       const t = tools[last]
       tools[last] = {
         ...t,
         providerOptions: {
           ...t.providerOptions,
           anthropic: {
             ...(t.providerOptions?.anthropic as Record<string, unknown> | undefined),
             cacheControl: { type: "ephemeral" },
           },
         },
       }
     }
   }
   ```

   This ensures the full tools array is cached as a prefix. On turn 2+, the provider recognizes the identical tool bytes and serves them from cache. The `anthropic_tool_search_bm25` tool (if added after) is a small reference that doesn't need caching.

   **Verification note:** After implementing, verify `cacheControl` appears in the serialized API request by checking `cache_control` on the last tool in the wire format. The `deferLoading` pattern at line 512-523 uses the same `providerOptions.anthropic` path, confirming the AI SDK forwards these options. If empirical testing shows `cacheControl` is not forwarded on tools, fall back to placing the breakpoint via the `transformParams` middleware in `llm.ts:320-326`.

**Verify:**

```bash
cd packages/opencode && bun typecheck
cd packages/opencode && bun test
```

### System Prompt Caching Fix

#### Task 3: Fix `applyCaching` to handle more than 2 system messages

**Context:** `packages/opencode/src/provider/transform.ts` (applyCaching at line 192), `packages/opencode/src/session/llm.ts` (system collapse at line 117), `packages/opencode/src/plugin/claude-oauth/index.ts` (billing prepend at line 115)

**Files:**

- Modify: `packages/opencode/src/provider/transform.ts` (change `applyCaching` system message selection)

**Steps:**

1. [ ] In `packages/opencode/src/provider/transform.ts`, in the `applyCaching` function (line 192), change the system message selection from `.slice(0, 2)` to `.slice(-2)` (take the LAST 2 system messages instead of the first 2):

   Change line 193 from:

   ```typescript
   const system = msgs.filter((msg) => msg.role === "system").slice(0, 2)
   ```

   To:

   ```typescript
   const system = msgs.filter((msg) => msg.role === "system").slice(-2)
   ```

   **Why `.slice(-2)` instead of removing the limit entirely:** Bedrock has a hard limit of 4 cache breakpoints. The current code uses 2 system + 2 final = 4 breakpoints (at the limit). Removing `.slice()` entirely would produce N system + 2 final breakpoints — when the Claude OAuth plugin creates 3-4 system messages, this yields 5-6 breakpoints and causes Bedrock API errors.

   Using `.slice(-2)` maintains exactly 4 total breakpoints (2 system + 2 final) while ensuring the LAST system message (the 50KB prompt) is always in the cached set. The billing header (~80 chars, first system message) loses its explicit cache breakpoint, but it's still included in the cached prefix since prompt caching works on byte-identical prefixes — everything before the first breakpoint is part of that prefix.

   **Root cause:** The Claude OAuth plugin (at `claude-oauth/index.ts:115-128`) prepends a billing header and "You are Claude Code" entry via the `experimental.chat.system.transform` hook. This runs AFTER `llm.ts:117` captures the `header` reference but BEFORE the collapse guard at `llm.ts:124`. The guard `system[0] === header` fails because `system[0]` is now the billing header, leaving 3-4 system messages. With `.slice(0, 2)`, only the first 2 (billing + identity, ~140 chars) get `cacheControl` — the 50KB prompt does not. With `.slice(-2)`, the identity + 50KB prompt get `cacheControl` instead.

**Verify:**

```bash
cd packages/opencode && bun typecheck
cd packages/opencode && bun test
```

---

## Design Notes

### Why names-only in the skill tool?

The system prompt already contains `## Available Skills` with `- **name**: description` for every skill (via `SystemPrompt.skills()` at `system.ts:63-73`). Duplicating this in the tool description wastes ~25KB. The model can cross-reference the system prompt to match a task to a skill name. Names-only in the tool description is sufficient for the model to know what to pass as the `name` parameter.

### Why cache the last tool specifically?

Anthropic's prompt caching works on byte-identical prefixes. The cache breakpoint must be on the last item in a block to cache the entire block. By marking the last tool (whatever it happens to be), the full tools array up to that point is cached. On subsequent turns, if tools haven't changed, the provider serves them from cache — saving ~211KB of input token processing per turn.

### Why not also shorten bash/todowrite/task descriptions?

These tools have long descriptions (9.6KB, 8.8KB, 6.1KB respectively) but they contain important behavioral instructions that the model relies on. Shortening them risks degrading tool use quality. The cache_control fix (Task 2) makes their size irrelevant after the first turn since they're cached. This is a better cost/quality tradeoff than rewriting tool descriptions.

### Root cause of the system prompt caching regression

The `experimental.chat.system.transform` plugin hook runs between the `header` capture (`llm.ts:117`) and the collapse guard (`llm.ts:124`). The Claude OAuth plugin prepends 2 entries, making `system[0] !== header`, so the collapse to 2 parts is skipped. The system stays as 4 entries. `applyCaching` only marks the first 2 with `cacheControl`, missing the large 50KB prompt. The fix (`.slice(-2)`) targets the important system messages while staying within Bedrock's 4-breakpoint limit.

### Why `.slice(-2)` instead of removing the limit?

Bedrock's Anthropic API has a hard limit of 4 cache breakpoints. The `applyCaching` function applies cache options for ALL providers simultaneously (anthropic, bedrock, openrouter, copilot, openaiCompatible). Current usage: 2 system + 2 final = 4 (at the limit). Removing the limit entirely would exceed this for any user with >2 system messages. Using `.slice(-2)` keeps the count at 4 while prioritizing the large system prompt over the small billing header.

### Why place tool cache_control before `anthropic_tool_search_bm25`?

The `anthropic_tool_search_bm25` tool is a provider tool reference (`tool_reference` type), not a full tool definition. It uses a different API schema and may not support `cache_control`. By placing the breakpoint on the last regular tool, we ensure all full tool definitions (211KB) are cached. The tool search reference (~100 chars) sits outside the cached prefix, which is acceptable.

## Review Notes

Devil's advocate review caught:

1. **Bedrock 4-cache-point limit** (critical) — Resolved by using `.slice(-2)` instead of removing the limit entirely.
2. **Skill descriptions absent when permission-denied** — Not a regression; both system prompt and tool description are already absent in that edge case. Noted in Task 1.
3. **`anthropic_tool_search_bm25` may not support cache_control** — Resolved by placing the breakpoint before the tool search is added.
4. **AI SDK cacheControl forwarding on tools** — The `deferLoading` pattern proves `providerOptions.anthropic` is forwarded. Added empirical verification note as a fallback.
5. **Reuse `Skill.fmt(list, { compact: true })` instead of reimplementing** — Adopted.
