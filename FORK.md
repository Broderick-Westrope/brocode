# OpenCode Fork

## Changes

### 2026-04-03 — Deferred MCP tool loading

MCP tools can now be deferred so the model only sees their names until it needs them. When the model wants to use a deferred tool, the Anthropic API's built-in tool search finds and loads the full schema on demand. This keeps 80+ MCP tool schemas out of every turn's context.

Saves ~20-30K tokens with many MCP tools connected. Requires Anthropic models (Claude Sonnet 4+, Opus 4+). Enable with:

```jsonc
{
  "experimental": {
    "defer_tools": true
  }
}
```

### 2026-04-03 — Tool schema caching

Tool definitions and their transformed schemas are now cached per-session instead of recomputed on every turn. This improves prompt cache hit rates with providers that support it, since the serialized tool blocks stay byte-identical across turns.

### 2026-04-03 — Compact skill listing

The system prompt included full descriptions, XML markup, and file paths for every installed skill. Now it uses a compact markdown list with names and descriptions only, dropping the XML wrapper and location URLs. Saves ~3-5K tokens for large skill sets.
