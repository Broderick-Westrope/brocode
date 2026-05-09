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

Add `lazy_description?: string` to both `Local` and `Remote` schemas. Interaction with `enabled: false`: `enabled: false` takes priority — the MCP is disabled and never connects, regardless of `lazy_description`.

### 2. MCP Service (`src/mcp/index.ts`)

**New status value:** Add `"lazy"` to the `Status` union type and add a corresponding `StatusLazy` variant to the status discriminated union (alongside `StatusConnected`, `StatusDisabled`, etc.).

**Init loop change:** In `create()`, after successful connection and tool fetch:
- If `lazy_description` is present on the config entry, set `status = "lazy"` instead of `"connected"`
- Store tools in `defs` as normal (they're fetched, just not exposed)
- If connection or tool fetch fails, status is `"failed"` as today — lazy logic only applies after successful init

**New `enable(name)` method:**
- If `status === "lazy"`: transition to `"connected"`, publish `ToolsChanged` bus event, return `{ enabled: true, tools: string[] }`
- If `status === "connected"`: no-op, return `{ enabled: true, tools: string[] }`
- If `status === "needs_auth"`: return `{ enabled: false, reason: "MCP 'name' requires OAuth authentication. The user should run: opencode mcp auth name" }`
- Otherwise: return `{ enabled: false, reason: "MCP 'name' is in status 'X' and cannot be enabled" }`

**New `toLazy(name)` method:**
- If `status === "connected"` and MCP has `lazy_description` in config: transition to `"lazy"`, publish `ToolsChanged` bus event (tools disappear, discovery block reappears)
- If MCP has no `lazy_description`: return error (can't return to lazy — it was never lazy)
- If `status === "lazy"`: no-op

**TUI dialog cycling (`dialog-mcp.tsx`):** Space toggles cycle through states. The cycle depends on whether the MCP has `lazy_description`:

Non-lazy MCPs (unchanged): `disabled` ↔ `connected`

Lazy-capable MCPs: `disabled` → `lazy` → `connected` → `lazy` → `connected` → ...

| Current status | Space → next |
|---|---|
| `disabled` | `lazy` (if has `lazy_description`) or `connected` (if not) |
| `lazy` | `connected` |
| `connected` (has `lazy_description`) | `lazy` |
| `connected` (no `lazy_description`) | `disabled` |

To hard-disable a lazy MCP, the user cycles from `connected` → `lazy` → then the existing `toggle()` from `lazy` goes to `connected`, not `disabled`. So we need a **`d` keybinding** to force-disable from any state (jumps straight to `disabled`).

The `toggle()` method in `local.mcp` needs updating to implement this cycle logic, checking whether the MCP has `lazy_description` in config to determine the next state.

**`tools()` method:** No change needed — already filters to `status === "connected"`.

**CLI status display (`cli/cmd/mcp.ts`):** Add handling for `"lazy"` status with a distinct icon (e.g., `"◌"`) and label like `"available (lazy)"`.

**TUI dialog (`dialog-mcp.tsx`):** Handle `"lazy"` status display. Show the return-to-lazy action only for connected MCPs that have `lazy_description`.

**SDK regeneration:** After adding `StatusLazy` to the union, regenerate the JS SDK via `./packages/sdk/js/script/build.ts`.

### 3. Built-in Tool (`src/tool/`)

Register `enable_mcp` as a built-in tool:
- Schema: `{ name: z.string() }` — the MCP server config key (e.g., `"datadog"`, not a display name)
- Handler: calls `MCP.enable(name)`, returns structured result (see enable() return shapes above)
- **Conditional registration:** Only register this tool when at least one MCP has `lazy_description` configured. If no lazy MCPs exist, the tool is not registered and no system prompt block is emitted. This avoids 100 tokens of dead weight.
- **Dependency:** The handler needs `MCP.Service`. Since `ToolRegistry` doesn't currently depend on `MCP.Service`, this tool should be registered in `session/prompt.ts` during `resolveTools()` (where MCP access already exists) rather than in `tool/registry.ts`. Alternatively, add it as a dynamic tool alongside the MCP tools merge.

### 4. System Prompt (`src/session/system.ts`)

New function that reads MCP state, filters to `status === "lazy"`, and emits:

```
## Available MCP Servers (not yet enabled)
The following MCP servers are available but not loaded. Call enable_mcp(name) to activate one:
- datadog: Datadog observability: logs, traces, metrics, monitors, dashboards, incidents, RUM, SLOs
- linear: Linear project management: issues, projects, cycles, documents, initiatives
```

Injected into the system prompt array alongside environment/skills blocks. Only emitted when at least one MCP has `status === "lazy"`.

Note: After enablement, the discovery block updates on the next loop iteration (system prompt is re-assembled each step). The current step's system prompt is stale but the agent sees the `enable_mcp` tool result confirming success, so this is benign.

### 5. Subagent Behavior

Subagents (task tool) share the same `MCP.Service` instance via `InstanceState`. A lazy MCP enabled by any agent (parent or sub) becomes enabled for all agents in the session. This is the desired behavior — if a subagent needs Datadog, the tools should be available.

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
