# Lazy MCP Loading Implementation Plan

> **Status:** DRAFT

## Specification

**Problem:** MCP tool definitions consume ~9700+ tokens in every LLM call regardless of whether the conversation needs them. Datadog alone contributes ~4000 tokens across 40+ tools. Most conversations (code editing, refactoring, planning) never touch these tools.

**Goal:** Reduce tool-definition token overhead by ~85% for conversations that don't need heavy MCPs, while preserving instant access when they are needed. MCPs marked with `lazy_description` pre-connect on startup but hide their tools until the agent explicitly enables them.

**Scope:**
- In: `lazy_description` config field, new `"lazy"` MCP status, `enable_mcp` built-in tool, system prompt discovery block, TUI cycling, API routes
- Out: auto-disable mid-conversation, keyword-based auto-enable, threshold-based lazy detection

**Success Criteria:**
- [ ] MCPs with `lazy_description` connect on startup but their tools are hidden from the LLM
- [ ] A built-in `enable_mcp` tool is available when at least one lazy MCP exists
- [ ] System prompt includes a discovery block listing lazy MCPs by name + description
- [ ] Calling `enable_mcp("datadog")` transitions from `"lazy"` to `"connected"` and tools appear on next LLM call
- [ ] MCPs without `lazy_description` behave exactly as today
- [ ] TUI Space cycles: `disabled` → `lazy` → `connected` → `lazy` for lazy-capable MCPs; `d` keybinding force-disables
- [ ] `enable` and `toLazy` API routes exist alongside existing `connect`/`disconnect`
- [ ] SDK regenerated with new `StatusLazy` type
- [ ] CLI `mcp list` displays lazy status with distinct icon

## Context Loading

_Run before starting:_

```bash
read packages/opencode/src/config/mcp.ts
read packages/opencode/src/mcp/index.ts
read packages/opencode/src/session/system.ts
read packages/opencode/src/session/prompt.ts:440-550
read packages/opencode/src/session/prompt.ts:1520-1590
read packages/opencode/src/cli/cmd/tui/component/dialog-mcp.tsx
read packages/opencode/src/cli/cmd/tui/feature-plugins/sidebar/mcp.tsx
read packages/opencode/src/cli/cmd/tui/context/local.tsx:378-398
read packages/opencode/src/cli/cmd/mcp.ts:130-170
read packages/opencode/src/server/routes/instance/mcp.ts:220-277
read packages/opencode/src/server/routes/instance/httpapi/groups/mcp.ts
read packages/opencode/src/server/routes/instance/httpapi/handlers/mcp.ts
```

## Tasks

### MCP Core (config, service, status)

#### Task 1: Add `lazy_description` to config schema and `StatusLazy` to MCP status

**Context:** `packages/opencode/src/config/mcp.ts`, `packages/opencode/src/mcp/index.ts`

**Files:**
- Modify: `packages/opencode/src/config/mcp.ts` (add `lazy_description` field to `Local` and `Remote`)
- Modify: `packages/opencode/src/mcp/index.ts` (add `StatusLazy` variant, update `Status` union, add `enable`/`toLazy` methods, update `storeClient`, update `Interface`)

**Steps:**

1. [ ] In `packages/opencode/src/config/mcp.ts`, add `lazy_description: Schema.optional(Schema.String).annotate({ description: "If set, this MCP starts in lazy mode (pre-connected, tools hidden). The description helps the agent decide when to enable it." })` to both the `Local` and `Remote` `Schema.Struct` definitions, before the `enabled` field.

2. [ ] In `packages/opencode/src/mcp/index.ts`, add a new status variant after the existing ones:
   ```ts
   const StatusLazy = Schema.Struct({ status: Schema.Literal("lazy") }).annotate({
     identifier: "MCPStatusLazy",
   })
   ```
   Add `StatusLazy` to the `Status` union array (between `StatusConnected` and `StatusDisabled`).

3. [ ] In the `Interface` type, add two new methods:
   ```ts
   readonly enable: (name: string) => Effect.Effect<{ enabled: boolean; tools?: string[]; reason?: string }>
   readonly toLazy: (name: string) => Effect.Effect<{ success: boolean; reason?: string }>
   readonly lazyMcps: () => Effect.Effect<Array<{ name: string; description: string }>>
   ```

4. [ ] Update `storeClient()` to be lazy-aware. This is the single place where status is set to `"connected"` after a successful client creation, and it handles both the init loop and `connect()`/`createAndStore()` reconnect paths. Change it to check `lazy_description`:
   ```ts
   const storeClient = Effect.fnUntraced(function* (
     s: State,
     name: string,
     client: MCPClient,
     listed: MCPToolDef[],
     timeout?: number,
   ) {
     const bridge = yield* EffectBridge.make()
     yield* closeClient(s, name)
     const mcpConfig = yield* getMcpConfig(name)
     const isLazy = mcpConfig && isMcpConfigured(mcpConfig) && "lazy_description" in mcpConfig && mcpConfig.lazy_description
     s.status[name] = isLazy ? { status: "lazy" } : { status: "connected" }
     s.clients[name] = client
     s.defs[name] = listed
     watch(s, name, client, bridge, timeout)
     return s.status[name]
   })
   ```
   This means both the init loop (which calls `storeClient` via `create()` results) and `connect()`→`createAndStore()`→`storeClient()` will correctly produce `"lazy"` status for lazy-capable MCPs. No separate init-loop override is needed.

5. [ ] Implement the `enable` method — a lightweight status flip (no reconnection):
   ```ts
   const enable = Effect.fn("MCP.enable")(function* (name: string) {
     const s = yield* InstanceState.get(state)
     if (s.status[name]?.status === "lazy") {
       s.status[name] = { status: "connected" }
       yield* bus.publish(ToolsChanged, { server: name }).pipe(Effect.ignore)
       return { enabled: true, tools: s.defs[name]?.map(t => t.name) ?? [] }
     }
     if (s.status[name]?.status === "connected")
       return { enabled: true, tools: s.defs[name]?.map(t => t.name) ?? [] }
     if (s.status[name]?.status === "needs_auth")
       return { enabled: false, reason: `MCP '${name}' requires OAuth authentication. The user should run: opencode mcp auth ${name}` }
     return { enabled: false, reason: `MCP '${name}' is in status '${s.status[name]?.status ?? "unknown"}' and cannot be enabled` }
   })
   ```

6. [ ] Implement the `toLazy` method:
   ```ts
   const toLazy = Effect.fn("MCP.toLazy")(function* (name: string) {
     const mcpConfig = yield* getMcpConfig(name)
     if (!mcpConfig || !isMcpConfigured(mcpConfig) || !("lazy_description" in mcpConfig) || !mcpConfig.lazy_description)
       return { success: false, reason: `MCP '${name}' is not configured as lazy` }
     const s = yield* InstanceState.get(state)
     if (s.status[name]?.status === "connected") {
       s.status[name] = { status: "lazy" }
       yield* bus.publish(ToolsChanged, { server: name }).pipe(Effect.ignore)
       return { success: true }
     }
     if (s.status[name]?.status === "lazy") return { success: true }
     return { success: false, reason: `MCP '${name}' cannot return to lazy from status '${s.status[name]?.status}'` }
   })
   ```

7. [ ] Implement the `lazyMcps` method — returns info for system prompt discovery:
   ```ts
   const lazyMcps = Effect.fn("MCP.lazyMcps")(function* () {
     const s = yield* InstanceState.get(state)
     const cfg = yield* cfgSvc.get()
     const config = cfg.mcp ?? {}
     const result: Array<{ name: string; description: string }> = []
     for (const [key, mcpConfig] of Object.entries(config)) {
       if (!isMcpConfigured(mcpConfig)) continue
       if (s.status[key]?.status !== "lazy") continue
       if ("lazy_description" in mcpConfig && mcpConfig.lazy_description)
         result.push({ name: key, description: mcpConfig.lazy_description })
     }
     return result
   })
   ```

8. [ ] Add `enable`, `toLazy`, and `lazyMcps` to the `Service.of({...})` return object.

9. [ ] In the `watch()` function, update the guard at line 475: change `s.status[name]?.status !== "connected"` to `s.status[name]?.status !== "connected" && s.status[name]?.status !== "lazy"` so that tool list change notifications are also processed for lazy MCPs (their defs should stay up-to-date even while hidden).

**Verify:**
```bash
bun typecheck
# Expected: no type errors in packages/opencode
```

#### Task 2: Add `enable_mcp` built-in tool and system prompt discovery block

**Context:** `packages/opencode/src/session/prompt.ts`, `packages/opencode/src/session/system.ts`, `packages/opencode/src/mcp/index.ts`

**Files:**
- Modify: `packages/opencode/src/session/prompt.ts` (add `enable_mcp` dynamic tool in `resolveTools()`, add lazy MCP discovery to system prompt assembly)

Note: `SystemPrompt` (`system.ts`) is NOT modified. The lazy MCP data comes from `MCP.Service.lazyMcps()` which is already available in `prompt.ts`. This avoids adding heavy MCP/Config layer dependencies to `SystemPrompt`.

**Steps:**

1. [ ] In `packages/opencode/src/session/prompt.ts`, in the `resolveTools()` function, after the MCP tools merge loop (after the `for (const [key, item] of Object.entries(yield* mcp.tools()))` block):
   - Get lazy MCPs: `const lazyMcpList = yield* mcp.lazyMcps()`
   - If `lazyMcpList.length > 0`, add an `enable_mcp` dynamic tool to the `tools` record. Use `dynamicTool` (already imported) with `jsonSchema` (already imported) to match the pattern used for MCP tools:
     ```ts
     if (lazyMcpList.length > 0) {
       tools["enable_mcp"] = dynamicTool({
         description: "Enable a lazy-loaded MCP server to make its tools available. Call this when you need tools from an MCP that is listed in the 'Available MCP Servers' section of the system prompt.",
         inputSchema: jsonSchema({
           type: "object" as const,
           properties: {
             name: { type: "string", description: "The MCP server name to enable (e.g., 'datadog', 'linear')" },
           },
           required: ["name"],
           additionalProperties: false,
         }),
         execute: async (args) => {
           const result = await run.promise(mcp.enable((args as { name: string }).name))
           return {
             content: [{ type: "text" as const, text: JSON.stringify(result) }],
           }
         },
       })
     }
     ```
   - Note: `dynamicTool`, `jsonSchema` are already imported. `run` (EffectBridge) and `mcp` (MCP.Service) are already in scope within `resolveTools`. The `execute` return matches MCP tool output format (`{ content: [{ type: "text", text }] }`).

2. [ ] In the system prompt assembly section of `prompt.ts` (around line 1568-1574), add the lazy MCP discovery block. After the existing `Effect.all` call, add:
   ```ts
   const lazyMcpInfo = yield* mcp.lazyMcps()
   if (lazyMcpInfo.length > 0) {
     const block = [
       "## Available MCP Servers (not yet enabled)",
       "The following MCP servers are available but not loaded. Call enable_mcp(name) to activate one:",
       ...lazyMcpInfo.map(m => `- ${m.name}: ${m.description}`),
     ].join("\n")
     system.push(block)
   }
   ```
   This goes after `const system = [...]` is constructed and before `const result = yield* handle.process(...)`.

**Verify:**
```bash
bun typecheck
# Expected: no type errors in packages/opencode
```

### API & SDK

#### Task 3: Add `enable` and `toLazy` API routes, update SDK

**Context:** `packages/opencode/src/server/routes/instance/mcp.ts`, `packages/opencode/src/server/routes/instance/httpapi/groups/mcp.ts`, `packages/opencode/src/server/routes/instance/httpapi/handlers/mcp.ts`

Both Hono and HttpApi routes must be updated for parity (per `packages/opencode/src/server/routes/instance/AGENTS.md`).

**Files:**
- Modify: `packages/opencode/src/server/routes/instance/mcp.ts` (add `enable` and `toLazy` Hono routes)
- Modify: `packages/opencode/src/server/routes/instance/httpapi/groups/mcp.ts` (add `enable` and `toLazy` endpoints)
- Modify: `packages/opencode/src/server/routes/instance/httpapi/handlers/mcp.ts` (add `enable` and `toLazy` handlers)
- Regenerate: `packages/sdk/js/` (run build script)

**Steps:**

1. [ ] In `packages/opencode/src/server/routes/instance/mcp.ts`, add two new routes after the `disconnect` route:
   ```ts
   .post(
     "/:name/enable",
     describeRoute({
       description: "Enable a lazy MCP server (lightweight status flip, no reconnection)",
       operationId: "mcp.enable",
       responses: {
         200: {
           description: "MCP server enabled",
           content: { "application/json": { schema: resolver(z.boolean()) } },
         },
       },
     }),
     validator("param", z.object({ name: z.string() })),
     async (c) =>
       jsonRequest("McpRoutes.enable", c, function* () {
         const { name } = c.req.valid("param")
         const mcp = yield* MCP.Service
         yield* mcp.enable(name)
         return true
       }),
   )
   .post(
     "/:name/toLazy",
     describeRoute({
       description: "Return a connected MCP server to lazy state (tools hidden)",
       operationId: "mcp.toLazy",
       responses: {
         200: {
           description: "MCP server returned to lazy state",
           content: { "application/json": { schema: resolver(z.boolean()) } },
         },
       },
     }),
     validator("param", z.object({ name: z.string() })),
     async (c) =>
       jsonRequest("McpRoutes.toLazy", c, function* () {
         const { name } = c.req.valid("param")
         const mcp = yield* MCP.Service
         yield* mcp.toLazy(name)
         return true
       }),
   )
   ```

2. [ ] In `packages/opencode/src/server/routes/instance/httpapi/groups/mcp.ts`:
   - Add to `McpPaths`:
     ```ts
     enable: "/mcp/:name/enable",
     toLazy: "/mcp/:name/toLazy",
     ```
   - Add two new endpoints to the group (after the `disconnect` endpoint):
     ```ts
     HttpApiEndpoint.post("enable", McpPaths.enable, {
       params: { name: Schema.String },
       success: described(Schema.Boolean, "MCP server enabled"),
     }).annotateMerge(
       OpenApi.annotations({
         identifier: "mcp.enable",
         description: "Enable a lazy MCP server (lightweight status flip).",
       }),
     ),
     HttpApiEndpoint.post("toLazy", McpPaths.toLazy, {
       params: { name: Schema.String },
       success: described(Schema.Boolean, "MCP server returned to lazy state"),
     }).annotateMerge(
       OpenApi.annotations({
         identifier: "mcp.toLazy",
         description: "Return a connected MCP server to lazy state (tools hidden).",
       }),
     ),
     ```

3. [ ] In `packages/opencode/src/server/routes/instance/httpapi/handlers/mcp.ts`:
   - Add handlers:
     ```ts
     const enable = Effect.fn("McpHttpApi.enable")(function* (ctx: { params: { name: string } }) {
       yield* mcp.enable(ctx.params.name)
       return true
     })
     const toLazy = Effect.fn("McpHttpApi.toLazy")(function* (ctx: { params: { name: string } }) {
       yield* mcp.toLazy(ctx.params.name)
       return true
     })
     ```
   - Add `.handle("enable", enable).handle("toLazy", toLazy)` to the handlers chain

4. [ ] Regenerate the JS SDK: run `bun run ./packages/sdk/js/script/build.ts`. This picks up `StatusLazy` in the `Status` union and the new `enable`/`toLazy` endpoints.

**Verify:**
```bash
bun run ./packages/sdk/js/script/build.ts
bun typecheck
# Expected: SDK regenerates successfully, no type errors
```

### TUI & CLI

#### Task 4: Update TUI dialog, sidebar, and CLI for lazy status

**Context:** `packages/opencode/src/cli/cmd/tui/component/dialog-mcp.tsx`, `packages/opencode/src/cli/cmd/tui/feature-plugins/sidebar/mcp.tsx`, `packages/opencode/src/cli/cmd/tui/context/local.tsx`, `packages/opencode/src/cli/cmd/mcp.ts`

**Files:**
- Modify: `packages/opencode/src/cli/cmd/tui/context/local.tsx` (update `toggle` to cycle through lazy states, add `forceDisable`)
- Modify: `packages/opencode/src/cli/cmd/tui/component/dialog-mcp.tsx` (update `Status` component for lazy, add `d` keybind)
- Modify: `packages/opencode/src/cli/cmd/tui/feature-plugins/sidebar/mcp.tsx` (add lazy status display)
- Modify: `packages/opencode/src/cli/cmd/mcp.ts` (add lazy status icon/text in `mcp list`)

**Steps:**

1. [ ] In `packages/opencode/src/cli/cmd/tui/context/local.tsx`, update the `mcp` object:
   - `isEnabled` is already correct — `"lazy"` won't return true.
   - Update `toggle` to implement cycling. Use the `enable` endpoint for `lazy` → `connected` (lightweight flip, no reconnect) and `toLazy` for `connected` → `lazy`:
     ```ts
     async toggle(name: string) {
       const status = sync.data.mcp[name]
       if (status?.status === "connected") {
         // Try return to lazy; if not lazy-capable, toLazy returns { success: false }
         const result = await sdk.client.mcp.toLazy({ name })
         if (!result.data) {
           await sdk.client.mcp.disconnect({ name })
         }
       } else if (status?.status === "lazy") {
         await sdk.client.mcp.enable({ name })
       } else {
         // disabled/failed/etc → reconnect (storeClient handles lazy_description check)
         await sdk.client.mcp.connect({ name })
       }
     },
     ```
     Note: `sdk.client.mcp.enable` and `sdk.client.mcp.toLazy` will exist after SDK regeneration in Task 3.
   - Add a `forceDisable` method:
     ```ts
     async forceDisable(name: string) {
       await sdk.client.mcp.disconnect({ name })
     },
     ```

2. [ ] In `packages/opencode/src/cli/cmd/tui/component/dialog-mcp.tsx`:
   - Update the `Status` component to handle lazy — change props from `{ enabled: boolean; loading: boolean }` to `{ status: string; loading: boolean }`:
     ```tsx
     function Status(props: { status: string; loading: boolean }) {
       const { theme } = useTheme()
       if (props.loading) return <span style={{ fg: theme.textMuted }}>⋯ Loading</span>
       if (props.status === "connected") return <span style={{ fg: theme.success, attributes: TextAttributes.BOLD }}>✓ Enabled</span>
       if (props.status === "lazy") return <span style={{ fg: theme.warning }}>◌ Available</span>
       return <span style={{ fg: theme.textMuted }}>○ Disabled</span>
     }
     ```
   - Update the `footer` in the `options` memo to pass status string: `footer: <Status status={status.status} loading={loadingMcp === name} />`
   - Add a second keybind for force-disable (`d` key):
     ```ts
     {
       keybind: Keybind.parse("d")[0],
       title: "disable",
       onTrigger: async (option: DialogSelectOption<string>) => {
         if (loading() !== null) return
         setLoading(option.value)
         try {
           await local.mcp.forceDisable(option.value)
           const status = await sdk.client.mcp.status()
           if (status.data) sync.set("mcp", status.data)
         } catch (error) {
           console.error("Failed to disable MCP:", error)
         } finally {
           setLoading(null)
         }
       },
     },
     ```

3. [ ] In `packages/opencode/src/cli/cmd/tui/feature-plugins/sidebar/mcp.tsx`:
   - Add `lazy` to the `dot` function: `if (status === "lazy") return theme().warning`
   - Add a `<Match>` case: `<Match when={item.status === "lazy"}>Available</Match>`

4. [ ] In `packages/opencode/src/cli/cmd/mcp.ts`, in the status display section (around line 135-158), add a case for lazy status after the `"connected"` check:
   ```ts
   } else if (status.status === "lazy") {
     statusIcon = "◌"
     statusText = "available (lazy)"
   }
   ```

**Verify:**
```bash
bun typecheck
# Expected: no type errors in packages/opencode
```

<!-- Review notes (v2):
Fixes from devils-advocate review:
1. FIXED: lazy_description check moved into storeClient() instead of init loop — handles both init and reconnect paths
2. FIXED: SystemPrompt NOT modified — lazyMcps() lives on MCP.Service, called from prompt.ts where MCP is already available
3. FIXED: Uses dynamicTool + jsonSchema instead of z.object() — prompt.ts doesn't import zod's z
4. FIXED: Added enable API route — lightweight status flip avoids full reconnect when going lazy→connected
5. FIXED: TUI toggle uses enable endpoint for lazy→connected, not connect (avoids reconnect)
6. FIXED: TUI toggle uses structured result from toLazy instead of try/catch
7. NOTE: enable_mcp tool disappears once all lazy MCPs are enabled (conditional per-step). This is intentional — saves tokens.
8. NOTE: Tools appear on next LLM step after enable_mcp call (system prompt + tools re-resolved each step). Agent sees confirmation in tool result.
-->
