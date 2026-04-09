# Defer Tools — Checkpoint

## Status

Implementation complete, blocked by `opencode-claude-auth` plugin.

## What was built

`experimental.defer_tools` config option (boolean). When `true` and the model supports it, MCP tools are sent with `providerOptions.anthropic.deferLoading: true` and the Anthropic server-side BM25 tool search provider tool is added to the tools set. The Anthropic API handles on-demand schema expansion — no custom ToolSearchTool needed.

`supportsDefer` in `provider/transform.ts` gates the feature to direct Anthropic provider (`providerID === "anthropic"`) with model IDs containing `opus-4` or `sonnet-4`.

All changes typecheck and are committed on `feature/aggregate-tool-budget`.

## Files changed

- `packages/opencode/src/config/config.ts` — `experimental.defer_tools` schema
- `packages/opencode/src/provider/transform.ts` — `supportsDefer()`
- `packages/opencode/src/session/prompt.ts` — `shouldDefer()`, deferred MCP tool marking, tool search injection

## What blocked it

The `opencode-claude-auth` plugin intercepts every API request with a custom `fetch` and prefixes all tool names with `mcp_` (line 50-54 of `dist/transforms.js`). The Anthropic API requires the tool search tool name to be exactly `tool_search_tool_bm25` — it rejects `mcp_tool_search_tool_bm25`.

This is not fixable from the OpenCode side. The plugin's tool name translation happens after the AI SDK serializes the request.

## How to unblock

Replace the plugin with a first-class Anthropic OAuth provider in the fork. This uses `createAnthropic()` directly, so tools flow through the normal `@ai-sdk/anthropic` pipeline with no name mangling. Once OAuth auth works without the plugin, remove the plugin from the config and set `defer_tools: true`.

## Key research findings (from Group 1)

- `@ai-sdk/anthropic@3.0.64` natively supports `defer_loading` via `providerOptions.anthropic.deferLoading`
- `tool_reference` content blocks work via `type: "custom"` parts with `providerOptions.anthropic`
- Server-side tool search is available as `anthropic.tools.toolSearchBm25_20251119()` — no custom implementation needed
- Supported: Anthropic 1P API, Amazon Bedrock (InvokeModel only). Not supported: Google Vertex
- The AI SDK does NOT auto-add the `advanced-tool-use-2025-11-20` beta for `deferLoading` or tool search tools. If issues arise after unblocking, this header may need to be added manually
