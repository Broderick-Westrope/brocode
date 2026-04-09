# Plan: Deferred Tool Loading for MCP Tools in OpenCode

## Context

OpenCode sends full JSON schemas for every connected MCP tool on every LLM turn. With 80+ MCP tools, this costs ~30-40K tokens per turn. Claude Code avoids this via Anthropic's `defer_loading` beta API feature: deferred tools send only name + description (~50 tokens each instead of ~300), and the model loads full schemas on-demand via a `ToolSearchTool` that returns `tool_reference` content blocks.

### Key constraint

OpenCode uses the Vercel AI SDK (`ai` package + `@ai-sdk/anthropic`) rather than the Anthropic SDK directly. The AI SDK's `streamText()` does not natively support `defer_loading` or `tool_reference`. This plan must work **through or around** the AI SDK abstraction.

### Reference files

**OpenCode (modify):**
- `packages/opencode/src/session/llm.ts` — `streamText()` call, tool injection
- `packages/opencode/src/session/prompt.ts:392-565` — `resolveTools()` collects tools
- `packages/opencode/src/mcp/index.ts:611-644` — `MCP.tools()` returns all connected MCP tools
- `packages/opencode/src/tool/registry.ts` — built-in tool registration
- `packages/opencode/src/tool/tool.ts` — `Tool.Info` / `Tool.Def` types
- `packages/opencode/src/provider/transform.ts` — per-model schema transforms, provider options

**Claude Code (reference only):**
- `src/utils/api.ts:119-266` — `toolToAPISchema()` with `defer_loading: true`
- `src/tools/ToolSearchTool/ToolSearchTool.ts` — keyword search + `tool_reference` return
- `src/tools/ToolSearchTool/prompt.ts` — `isDeferredTool()` logic, prompt text
- `src/utils/toolSearch.ts` — threshold-based auto-deferral

---

## Group 1: AI SDK `defer_loading` feasibility

> **Goal:** Determine whether `defer_loading` can be passed through the AI SDK to the Anthropic API, or if a bypass is needed.

### Task 1.1: Investigate AI SDK provider options passthrough

The AI SDK's `@ai-sdk/anthropic` adapter accepts `providerOptions.anthropic` which gets merged into the raw API request. OpenCode already uses this path at `llm.ts:290`:

```ts
providerOptions: ProviderTransform.providerOptions(input.model, params.options)
```

Check whether:
- `providerOptions.anthropic.tools` can override or augment the tool array
- The `@ai-sdk/anthropic` adapter strips unknown fields from tool schemas before sending
- The middleware at `llm.ts:316-326` (`transformParams`) can inject `defer_loading` into tool definitions post-serialization

**Success criteria:** Confirm a path to get `defer_loading: true` onto specific tool schemas in the outbound API request, or confirm it's blocked and document why.

### Task 1.2: Investigate `tool_reference` in tool results

Claude Code returns `tool_reference` blocks in the `tool_result` content array:

```json
{
  "type": "tool_result",
  "tool_use_id": "...",
  "content": [{ "type": "tool_reference", "tool_name": "mcp__github__list_issues" }]
}
```

The Anthropic API expands this into the full schema. Check whether:
- The AI SDK's tool result handling allows arbitrary content block types (it likely serializes `ToolResultPart` as text)
- The middleware `transformParams` can intercept and rewrite tool results to include raw `tool_reference` blocks
- We need to use a custom `LanguageModel` wrapper or raw `fetch` for Anthropic-specific features

**Success criteria:** Confirm a path to return `tool_reference` blocks from a tool execution that the Anthropic API will expand, or document the workaround needed.

### Task 1.3: Determine provider scope

`defer_loading` and `tool_reference` are Anthropic beta features. Decide:
- Should this only activate for `@ai-sdk/anthropic` and `@ai-sdk/amazon-bedrock` providers?
- Should non-Anthropic providers fall back to sending all MCP tools upfront (current behavior)?
- Does Bedrock support `defer_loading`? (Claude Code's comment at `prompt.ts:441-442` suggests Bedrock/Vertex may NOT support `tool_reference`)

**Success criteria:** A provider allowlist for deferred loading. Likely: Anthropic 1P only, with a flag to test Bedrock.

---

## Group 2: ToolSearchTool implementation

> **Goal:** Build a built-in tool that the model can call to discover and load deferred MCP tools.

### Task 2.1: Create `packages/opencode/src/tool/search.ts`

Implement a new built-in tool following the `Tool.define()` pattern in `tool.ts`. Based on Claude Code's `ToolSearchTool.ts`:

**Parameters:**
```ts
z.object({
  query: z.string().describe('Use "select:<tool_name>" for direct selection, or keywords to search.'),
  max_results: z.number().optional().default(5),
})
```

**Search logic (simplified from Claude Code's ~300 lines):**
1. `select:name1,name2` — exact match by tool name, return matched names
2. Keyword search — split query into terms, score against tool name parts and descriptions
3. MCP prefix matching — `mcp_github` matches all `mcp_github_*` tools

**Return format:**
The tool must return matched tool names. The actual schema injection happens via `tool_reference` blocks (Task 1.2) or a fallback mechanism (Task 2.3).

**Key difference from Claude Code:** OpenCode names MCP tools as `server_tool` (single underscore) not `mcp__server__tool` (double underscore). Adjust parsing accordingly.

**Success criteria:** Tool registered in `registry.ts`, callable by the model, returns matched tool names from the deferred set.

### Task 2.2: Register ToolSearchTool in registry

Add to `registry.ts:120-141` alongside other built-in tools. Must:
- Only be included when deferred loading is active (provider supports it + MCP tools exist)
- Never be deferred itself
- Be registered before the LLM call so the model can use it on turn 1

### Task 2.3: Handle tool result format

Two strategies depending on Task 1.2 outcome:

**Strategy A (preferred): `tool_reference` blocks**
If the AI SDK middleware can inject raw `tool_reference` blocks, return them from the tool's execute function. The Anthropic API auto-expands the schema.

**Strategy B (fallback): Inline schema injection**
If `tool_reference` isn't viable through the AI SDK, the ToolSearchTool returns the full JSON schema as text in its output. The model reads the schema and can then call the tool. Less elegant but functional — similar to how Claude Code describes the fallback: "each matched tool appears as one `<function>` line."

**Success criteria:** After the model calls ToolSearchTool, it can subsequently call the matched MCP tool with correct parameters.

---

## Group 3: Tool resolution changes

> **Goal:** Split MCP tools into deferred (name + description only) and loaded (full schema) sets in the tool resolution pipeline.

### Task 3.1: Add deferred tool state to MCP service

In `mcp/index.ts`, add a new function alongside `tools()`:

```ts
const deferred = Effect.fn("MCP.deferred")(function* () {
  // Returns { name, description } for each connected MCP tool
  // WITHOUT full inputSchema
})
```

This provides the lightweight representation for deferred tools. The existing `tools()` function continues to return full tool definitions and is called by ToolSearchTool when a tool is selected.

### Task 3.2: Modify `resolveTools()` in `prompt.ts:392-565`

Currently, lines 485-562 iterate over ALL MCP tools and add them to the `tools` record with full schemas. Change this to:

1. Check if deferred loading is active (provider + config check)
2. If active: add MCP tools to a `deferred` set (name + description only), not to `tools`
3. Pass the `deferred` set to the LLM call so it can be serialized with `defer_loading: true`
4. When ToolSearchTool is called, use `MCP.tools()` to resolve the full schema for selected tools
5. If not active: current behavior (all MCP tools in `tools` with full schemas)

### Task 3.3: Modify `LLM.stream()` in `llm.ts:195-292`

The `streamText()` call at line 260 currently receives `tools` as a flat record. Update to:

1. Accept a `deferred` tools set alongside `tools`
2. Via the middleware at `llm.ts:316-326`, inject `defer_loading: true` onto deferred tool schemas
3. Ensure deferred tools appear in `activeTools` (line 291) so the model knows they exist
4. Handle the ToolSearchTool result to promote a deferred tool to fully loaded for subsequent turns

### Task 3.4: Track loaded deferred tools per-session

When ToolSearchTool successfully loads a tool, track it so:
- Subsequent turns include the full schema (tool is now "loaded")
- The deferred set shrinks over the session
- Compaction doesn't lose the loaded state

Store in session-level state, not message-level. Reset on new session.

---

## Group 4: Configuration and feature gating

> **Goal:** Make deferred loading opt-in/configurable so it doesn't break non-Anthropic providers.

### Task 4.1: Add configuration

In `config.ts`, add under `experimental`:

```ts
defer_tools?: boolean | "auto"
```

- `true`: Always defer MCP tools (for Anthropic providers)
- `"auto"`: Defer when MCP tool schemas exceed 10% of context window (matches Claude Code's default)
- `false` / omitted: Current behavior, all tools sent upfront

### Task 4.2: Add provider capability check

In `provider/transform.ts` or a new utility, add:

```ts
function supportsDefer(model: Provider.Model): boolean {
  return model.api.npm === "@ai-sdk/anthropic"
    // Optionally: || model.api.npm === "@ai-sdk/amazon-bedrock"
}
```

Gate all deferred loading behavior behind this check. Non-Anthropic providers always get full schemas.

### Task 4.3: Add auto-threshold logic

When `defer_tools: "auto"`:
1. Count approximate tokens for all MCP tool schemas (use character count / 2.5 as heuristic, matching Claude Code's `CHARS_PER_TOKEN`)
2. Compare against model's context window (`model.limit.context`)
3. If MCP tools exceed 10% of context, enable deferral

---

## Group 5: Persistent MCP enable/disable (bonus, low effort)

> **Goal:** When a user disables an MCP in the UI, persist that across sessions.

### Task 5.1: Write disable state to config

In `mcp/index.ts:604-609`, when `disconnect()` is called from a UI toggle:
1. Read current config
2. Set `mcp[name].enabled = false`
3. Write config back

On `connect()` (line 595-602), set `mcp[name].enabled = true`.

This is ~15 lines touching the disconnect/connect functions + config writer.

---

## Execution order

```
Group 1 (research, serial)     → determines architecture for Groups 2-3
Group 2 + Group 4 (parallel)   → ToolSearchTool + config, independent
Group 3 (after Group 1)        → tool resolution changes depend on feasibility answers
Group 5 (independent, any time) → small standalone change
```

## Risks

| Risk | Mitigation |
|------|-----------|
| AI SDK blocks `defer_loading` passthrough | Use middleware `transformParams` to inject raw fields, or contribute upstream PR to `@ai-sdk/anthropic` |
| AI SDK blocks `tool_reference` in tool results | Fall back to Strategy B (inline schema text). Less token-efficient but functional |
| Bedrock/Vertex don't support `tool_reference` | Scope to Anthropic 1P only initially |
| ToolSearchTool adds latency (extra round-trip) | Only on first use of a deferred tool. Subsequent turns have it loaded. Net positive for token cost |
| Breaking change for non-Anthropic providers | Feature-gated behind provider check + config flag. Zero change for non-Anthropic |
