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

### Compact skill listing

The system prompt uses a compact markdown list for skills (name + description only) instead of full XML with file paths. Saves ~3-5K tokens for large skill sets. Skills without descriptions are excluded.

### Cross-database session search

`brocode session search` queries sessions across all local databases (`~/.local/share/opencode/opencode*.db`), solving the problem of finding sessions when you don't remember which directory you launched from.

Searches by title (default), message content (`-m`), directory (`-d`), or date range (`--since`/`--until`). Opens all DBs read-only via `bun:sqlite` — no instance context needed.

```bash
brocode session search "query"          # search titles
brocode session search -m "query"       # search message content (slower)
brocode session search -d svc-core      # filter by directory
brocode session search --since 3d       # last 3 days
brocode session search --id ses_abc123  # full session detail
brocode session search --dbs            # list all databases
brocode session search --dirs           # directories ranked by session count
brocode session search --format json    # JSON output
```

### Branding

- Logo changed from "open" to "bro" in the TUI splash
- Binary name is `brocode` instead of `opencode`
- `install-local` npm script for building and installing to `~/.bun/bin/brocode`
