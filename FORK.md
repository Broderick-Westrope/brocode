# OpenCode Fork

## Changes

### Lazy MCP loading

MCP servers can be configured with a `lazy_description` field. These servers start pre-connected but with their tools hidden from the model. The system prompt lists lazy MCPs under "Available MCP Servers (not yet enabled)", and the model calls the built-in `enable_mcp` tool when it needs one.

This keeps large tool schemas (80+ tools across multiple MCPs) out of every turn's context until actually needed. Lazy MCPs show as "◌ Available" in the TUI sidebar and MCP dialog.

The MCP dialog also adds a `d` keybinding to force-disable any MCP, and lazy MCPs can be returned to lazy state via the `toLazy` API.

```jsonc
{
  "mcp": {
    "datadog": {
      "type": "local",
      "command": ["npx", "-y", "@anthropic/datadog-mcp"],
      "lazy_description": "Datadog observability: query logs, traces, spans, and metrics"
    }
  }
}
```

### Built-in Claude Code OAuth

Anthropic OAuth is a first-class auth method on the `anthropic` provider. Connect via "Claude Code (OAuth)" in the provider auth UI — no external plugin needed.

Reads credentials from macOS Keychain or `~/.claude/.credentials.json`, refreshes tokens automatically, and sends requests through the normal `@ai-sdk/anthropic` pipeline. Injects Claude Code identity and billing headers via `system.transform` hook. Removes the dependency on the `opencode-claude-auth` third-party plugin.

### RTK wrapper prefix stripping for permissions

The permission arity system strips known wrapper prefixes (like `rtk`) from bash command tokens before matching against the arity table. This fixes permission patterns not matching when commands are run through wrapper scripts.

### Compact skill listing

The system prompt uses a compact markdown list for skills (name + description only) instead of full XML with file paths. Saves ~3-5K tokens for large skill sets. Skills without descriptions are excluded.

### Branding

- Logo changed from "open" to "bro" in the TUI splash
- Binary name is `brocode` instead of `opencode`
- `install-local` npm script for building and installing to `~/.bun/bin/brocode`
