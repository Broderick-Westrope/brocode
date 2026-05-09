# Lazy MCP Loading Design Spec

**Problem:** MCP tool definitions consume ~9700+ tokens in every LLM call regardless of whether the conversation needs them. Datadog alone contributes ~4000 tokens across 40+ tools. Most conversations (code editing, refactoring, planning) never touch these tools.

**Goal:** Reduce tool-definition token overhead by ~85% for conversations that don't need heavy MCPs, while preserving instant access when they are needed.

**Scope:**
- In: `lazy_description` config field, new `"lazy"` MCP status, `enable_mcp` built-in tool, system prompt discovery block
- Out: auto-disable mid-conversation, keyword-based auto-enable, threshold-based lazy detection

**Constraints:**
- Backward-compatible: existing configs without `lazy_description` behave identically to today
- Pre-connect lazy MCPs on startup (no connection latency when agent enables)
- Enable-only: once enabled, stays enabled for the session (no thrashing)
- Single tool-call round-trip to enable (no list-then-enable dance)

**Success Criteria:**
- [ ] MCPs with `lazy_description` connect on startup but their tools are hidden from the LLM
- [ ] A built-in `enable_mcp` tool is available in every conversation
- [ ] System prompt includes a discovery block listing lazy MCPs by name + description
- [ ] Calling `enable_mcp("datadog")` transitions status from `"lazy"` to `"connected"` and tools appear on the next LLM call
- [ ] MCPs without `lazy_description` behave exactly as today
- [ ] Token overhead for lazy MCPs is ~50 tokens per MCP (system prompt line) + ~100 tokens (enable_mcp tool definition)

**Design Decisions:**

- **`lazy_description` as single config field:** If present, the MCP is lazy. Avoids a separate `lazy: boolean` + `description: string` pair. The description doubles as the opt-in flag.
- **Agent-driven enablement:** The agent decides when to enable MCPs based on conversation context, via a tool call. No keyword matching or automatic detection — keeps the logic simple and flexible.
- **Pre-connected, tools hidden:** Lazy MCPs connect on startup and fetch their tool list, but tools are filtered out of `resolveTools()` until enabled. This eliminates connection latency (~1-5s) when the agent enables. The tradeoff is resource usage (subprocesses/HTTP connections stay alive), but these are lightweight for remote MCPs.
- **Enable-only:** No disable capability. Once enabled, an MCP stays enabled for the conversation. Avoids thrashing and simplifies state management.
- **New `"lazy"` status:** Added to the existing status union (`"connected" | "disabled" | "error" | ...`). `tools()` already filters to `status === "connected"`, so `"lazy"` MCPs are automatically excluded without changing the filter logic.

## Implementation

### 1. Config Schema (`src/config/mcp.ts`)

Add `lazy_description?: string` to both `Local` and `Remote` schemas.

### 2. MCP Service (`src/mcp/index.ts`)

**New status value:** Add `"lazy"` to the status union type.

**Init loop change:** In `create()`, after successful connection and tool fetch:
- If `lazy_description` is present on the config entry, set `status = "lazy"` instead of `"connected"`
- Store tools in `defs` as normal (they're fetched, just not exposed)

**New `enable(name)` method:**
- If `status === "lazy"`: transition to `"connected"`, publish `ToolsChanged` bus event
- If `status === "connected"`: no-op
- Otherwise: return error

**`tools()` method:** No change needed — already filters to `status === "connected"`.

### 3. Built-in Tool (`src/tool/`)

Register `enable_mcp` as a built-in tool:
- Schema: `{ name: z.string() }` — the MCP server name from config
- Handler: calls `MCP.enable(name)`, returns `{ tools: string[] }` listing the newly available tool names
- Error cases: unknown name, already connected, disabled/errored MCP

### 4. System Prompt (`src/session/system.ts`)

New function that reads MCP state, filters to `status === "lazy"`, and emits:

```
## Available MCP Servers (not yet enabled)
The following MCP servers are available but not loaded. Call enable_mcp(name) to activate one:
- datadog: Datadog observability: logs, traces, metrics, monitors, dashboards, incidents, RUM, SLOs
- linear: Linear project management: issues, projects, cycles, documents, initiatives
```

Injected into the system prompt array alongside environment/skills blocks.

### Token Budget

| Component | Today | With lazy (3 MCPs lazy) |
|---|---|---|
| Datadog tools (40+) | ~4000 | 0 |
| Linear tools (~30) | ~3000 | 0 |
| LaunchDarkly tools (~15) | ~1500 | 0 |
| Sourcebot tools (~10) | ~800 | 800 |
| Atlas-wiki tools (~4) | ~400 | 400 |
| enable_mcp tool def | 0 | ~100 |
| System prompt block | 0 | ~150 |
| **Total** | **~9700** | **~1450** |

~85% reduction for conversations not using lazy MCPs.

**Context Files:**
- `packages/opencode/src/config/mcp.ts` — MCP config schemas (Local, Remote)
- `packages/opencode/src/config/config.ts:185-194` — top-level `config.mcp` field
- `packages/opencode/src/mcp/index.ts` — MCP service: create, connect, disconnect, tools, status lifecycle
- `packages/opencode/src/mcp/index.ts:614-628` — existing connect/disconnect methods
- `packages/opencode/src/mcp/index.ts:630-663` — tools() filtering by status
- `packages/opencode/src/tool/registry.ts` — built-in tool registration
- `packages/opencode/src/session/prompt.ts:368-546` — resolveTools() merging built-in + MCP tools
- `packages/opencode/src/session/system.ts` — system prompt assembly
- `packages/opencode/src/session/llm.ts:336-415` — streamText() call with tools param
