# Anthropic OAuth Provider — Implementation Plan

> **Status:** COMPLETED

## Specification

**Problem:** Using Anthropic models through Claude Code OAuth credentials requires the `opencode-claude-auth` third-party plugin. This plugin intercepts every API request with a custom `fetch` that blindly renames all tool names (prefixing with `mcp_`), which breaks Anthropic provider-defined tools like tool search. This blocks the `defer_tools` feature and any future Anthropic-specific tool features. The plugin is also a black box that's hard to debug when things go wrong.

**Goal:** Anthropic OAuth is a first-class auth method on the existing `anthropic` provider, sitting alongside the existing API key method. Users see both options when connecting the Anthropic provider and can switch between them. The OAuth path reads Claude Code credentials from the macOS Keychain or `~/.claude/.credentials.json`, refreshes tokens automatically, and sends requests through the normal `@ai-sdk/anthropic` pipeline — no tool name mangling, no response stream rewriting. `defer_tools` works out of the box.

**Scope:**

- In: Credential reading (Keychain + file), token refresh, billing headers, auth method UX, dummy API key pattern
- In: macOS Keychain support, Linux/Windows credentials file fallback
- Out: Multiple account switching (single account only for now)
- Out: Background credential sync, CLI fallback refresh
- Out: 1M context opt-in (can be added later)

**Success Criteria:**

- [ ] Can connect to Anthropic provider via "Claude Code (OAuth)" without an API key
- [ ] OAuth requests include correct authorization, billing, beta, and user-agent headers
- [ ] Tokens refresh automatically when near expiry
- [ ] Tools flow through normal `@ai-sdk/anthropic` pipeline (no name mangling)
- [ ] `defer_tools: true` works with OAuth auth
- [ ] Can switch to API key auth when OAuth usage is exhausted
- [ ] Works on macOS (Keychain) and Linux/Windows (credentials file)
- [ ] Graceful error when Claude Code credentials are missing ("Run `claude` to authenticate first")

**Auth precedence:** When `ANTHROPIC_API_KEY` is set via environment, the provider loads via the env source path and the auth plugin's loader is not invoked. OAuth only activates when the user explicitly connects via the "Claude Code (OAuth)" auth method in the UI, which stores an `oauth` type auth record. This matches how CodexAuthPlugin works — no conflict with env keys.

**Model availability:** All Anthropic models are available through OAuth. Costs are set to 0 since billing is handled server-side by Anthropic's OAuth infrastructure.

**Legal note:** This uses Claude Code's OAuth client ID (`9d1c250a-...`) and billing header format. This is the same approach as the existing third-party plugin. The user is responsible for compliance with Anthropic's Terms of Service.

## Context Loading

```bash
read packages/opencode/src/plugin/codex.ts
read packages/opencode/src/auth/index.ts
read packages/opencode/src/plugin/index.ts
read packages/opencode/src/provider/provider.ts offset=167 limit=50
```

## Credential Reading Tasks

### Task 1: Create credential reader

**Context:** The external plugin reads OAuth tokens from macOS Keychain (`security find-generic-password -s "Claude Code-credentials" -w`) or `~/.claude/.credentials.json`. We need a module that does the same without the external plugin.

**Files:**

- Create: `packages/opencode/src/plugin/claude-oauth/credentials.ts`

**Steps:**

1. [ ] Create `packages/opencode/src/plugin/claude-oauth/credentials.ts` with a `read()` function that:
   - On macOS (`process.platform === "darwin"`): spawns `security find-generic-password -s "Claude Code-credentials" -w` with a 2s timeout. Parses stdout as JSON.
     - Exit code 44 (item not found): fall through to file
     - Exit code 36 (Keychain locked) or timeout: fall through to file
     - Other errors: fall through to file
   - On all platforms (including macOS fallback): reads `~/.claude/.credentials.json`, parses JSON, extracts the `claudeAiOauth` property (falls back to root object if no wrapper)
   - Returns `{ access: string, refresh: string, expires: number } | undefined`
   - Validates all three fields are present and non-empty strings/number
   - If multiple accounts exist in Keychain (multiple `Claude Code-credentials*` entries), uses the first one found
   - Expected credential JSON shape from both Keychain and file:
     ```json
     { "accessToken": "sk-ant-...", "refreshToken": "sk-ant-refresh-...", "expiresAt": 1234567890000 }
     ```
     Map to `{ access: accessToken, refresh: refreshToken, expires: expiresAt }`

2. [ ] Export a `refresh(token: string)` function that:
   - POSTs to `https://claude.ai/v1/oauth/token` with URL-encoded body: `grant_type=refresh_token`, `client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e`, `refresh_token=<token>`
   - Content-Type: `application/x-www-form-urlencoded`
   - Timeout: 15s
   - Parses response: `{ access_token, refresh_token?, expires_in? }`
   - `expires_in` defaults to 36000 (10h) if missing
   - `refresh_token` reuses input token if not in response (rotation)
   - Returns `{ access, refresh, expires }` or undefined on any failure
   - Persists refreshed credentials back to `~/.claude/.credentials.json` (read existing file, update the `claudeAiOauth` object, write back with 0o600 permissions)

3. [ ] Export a `cached()` function that:
   - Maintains a single in-memory cache: `{ creds, at: number } | undefined`
   - If cache is valid (age < 30s) and token not within 60s of expiry: return cached
   - Otherwise: call `read()`, then check expiry
   - If within 60s of expiry: call `refresh(creds.refresh)`. Use a single in-flight promise to deduplicate concurrent refresh calls (store as `let pending: Promise | undefined`, clear on settle)
   - Update cache with result
   - Return credentials or undefined

**Verify:**

```bash
cd packages/opencode && bun typecheck
```

## Auth Plugin Tasks

### Task 2: Create internal auth plugin

**Context:** OpenCode has internal auth plugins (`CodexAuthPlugin`, `CopilotAuthPlugin`) registered in `plugin/index.ts`. These use the `auth.loader` hook to provide a custom `fetch` function and `auth.methods` to define authentication options in the UI. The Codex plugin at `plugin/codex.ts` is the reference implementation. Key pattern: return `apiKey: "oauth-placeholder"` from the loader so `@ai-sdk/anthropic` doesn't reject the missing key, then replace auth in the custom fetch.

**Files:**

- Create: `packages/opencode/src/plugin/claude-oauth/index.ts`
- Modify: `packages/opencode/src/plugin/index.ts` (add to INTERNAL_PLUGINS)

**Steps:**

1. [ ] Create `packages/opencode/src/plugin/claude-oauth/index.ts` exporting an async plugin function following the `CodexAuthPlugin` pattern:

   **`auth.provider`:** `"anthropic"`

   **`auth.loader(getAuth, provider)`:**
   - Check `const auth = await getAuth()` — only activate when `auth?.type === "oauth"`
   - Set all model costs to 0 (iterate `provider.models`, set `cost.input = 0`, `cost.output = 0`, etc.)
   - Return:
     ```ts
     {
       apiKey: "oauth-placeholder",  // SDK requires a key; replaced in custom fetch
       fetch: customFetch,
     }
     ```
   - `customFetch(url, init)`:
     - Call `cached()` to get fresh credentials. If undefined, throw with "Claude Code credentials not found. Run `claude` to authenticate."
     - Clone headers from init
     - Set `Authorization: Bearer <access_token>`
     - Set `anthropic-version: 2023-06-01`
     - Set `user-agent: claude-cli/<version> (external, cli)` (version from `process.env.ANTHROPIC_CLI_VERSION ?? "2.1.90"`)
     - Set `anthropic-beta` with flags: `claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,prompt-caching-scope-2026-01-05` (override via `process.env.ANTHROPIC_BETA_FLAGS` if set). Merge with any existing `anthropic-beta` header from the SDK (the CUSTOM_LOADER for anthropic adds `interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14`)
     - Set `x-app: cli`
     - Delete `x-api-key` if present (placeholder key must not be sent)
     - Call `fetch(url, { ...init, headers })`
     - On 401 response: clear credential cache, call `cached()` again to force refresh, retry once with new token
     - Does NOT transform request body, tool names, or response streams

   **`auth.methods`:** Two methods:
   - `{ label: "Claude Code (OAuth)", type: "oauth", authorize }` where `authorize()`:
     - Calls `read()` to check if Claude Code credentials exist
     - If not found: returns `{ url: "", instructions: "Claude Code credentials not found. Run \`claude\` in your terminal to authenticate, then try again.", method: "auto", callback: async () => ({ type: "error", error: "Credentials not found" }) }`
     - If found: returns `{ url: "", instructions: "Using Claude Code credentials.", method: "auto", callback: async () => ({ type: "success", provider: "anthropic", access: creds.access, refresh: creds.refresh, expires: creds.expires }) }`
   - `{ label: "API Key", type: "api" }` — standard API key input, handled by OpenCode

2. [ ] Add the plugin to `INTERNAL_PLUGINS` array in `packages/opencode/src/plugin/index.ts`

**Verify:**

```bash
cd packages/opencode && bun typecheck
```

## Billing Header Tasks

### Task 3: Add billing header and identity injection

**Context:** Anthropic's OAuth API requires two things injected into the system messages: (1) a Claude Code identity prefix as a separate system entry (required for OAuth validation), and (2) a billing header as a system text block at position 0. These are system message entries, not HTTP headers — the billing "header" is named confusingly but is actually a text block in the system array. The external plugin uses `experimental.chat.system.transform` for the identity prefix and modifies the request body for the billing entry.

**Files:**

- Create: `packages/opencode/src/plugin/claude-oauth/billing.ts`
- Modify: `packages/opencode/src/plugin/claude-oauth/index.ts` (add hooks)

**Steps:**

1. [ ] Create `packages/opencode/src/plugin/claude-oauth/billing.ts` with a `compute(messages, version, entrypoint)` function that:
   - Extracts the text of the first user message from the messages array (find message with `role === "user"`, get first text content, default to `""`)
   - Computes `cch`: first 5 hex chars of SHA-256 of that text
   - Computes version suffix: sample chars at indices 4, 7, 20 of the text (default `"0"` if index out of bounds), then first 3 hex chars of SHA-256 of `"59cf53e54c78" + sampled + version`
   - Returns: `x-anthropic-billing-header: cc_version=${version}.${suffix}; cc_entrypoint=${entrypoint}; cch=${cch};`
   - Use `Bun.CryptoHasher` or `crypto.subtle.digest` for SHA-256

2. [ ] In the plugin's `index.ts`, register an `experimental.chat.system.transform` hook that:
   - Only runs when current auth for anthropic is type `"oauth"` (check via `getAuth()`)
   - Prepends `"You are Claude Code, Anthropic's official CLI for Claude."` as a separate entry in `output.system` if not already present
   - Computes the billing header string using `compute()` and unshifts it into `output.system` at position 0

**Verify:**

```bash
cd packages/opencode && bun typecheck
```

## Integration Tasks

### Task 4: Remove external plugin dependency

**Context:** The external `opencode-claude-auth` plugin must be removed from config since our internal plugin now handles auth for the same provider. Having both would conflict.

**Files:**

- Modify: User's opencode config (document the migration)

**Steps:**

1. [ ] Remove `"opencode-claude-auth"` from the `plugin` array in opencode config files (project-level and/or `~/.config/opencode/opencode.json`)
2. [ ] Set `defer_tools: true` in `.opencode/opencode.jsonc`
3. [ ] Document in FORK.md: "Removed dependency on opencode-claude-auth plugin. Claude Code OAuth is now built-in — connect via the Anthropic provider's 'Claude Code (OAuth)' auth method."

**Verify:**

```
Run OpenCode. Anthropic provider should show two auth methods.
```

### Task 5: End-to-end verification

**Steps:**

1. [ ] Connect to Anthropic provider, select "Claude Code (OAuth)". Verify auth succeeds.
2. [ ] Send a message. Verify response received without errors.
3. [ ] With MCP tools connected, verify no tool name mangling errors.
4. [ ] With `defer_tools: true`, verify the tool search tool works (model can discover and use deferred MCP tools).
5. [ ] Disconnect OAuth auth. Reconnect with "API Key" method. Verify messages work with API key.

## File Structure

```
packages/opencode/src/plugin/claude-oauth/
├── index.ts          — Plugin entry (auth loader, methods, system transform hook)
├── credentials.ts    — Keychain/file reading, caching, refresh, dedup
└── billing.ts        — Billing header computation (SHA-256 hashing)
```

## Risks

| Risk                                                      | Mitigation                                                                                     |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Anthropic changes OAuth endpoint or billing header format | Match current external plugin behavior exactly; monitor for changes                            |
| Keychain access prompts or hangs on macOS (SSH, locked)   | 2s timeout with silent fallback to credentials file                                            |
| Beta flags change or new ones required                    | Env var override `ANTHROPIC_BETA_FLAGS` as escape hatch                                        |
| Claude Code credentials not present                       | Auth method returns clear error: "Run `claude` to authenticate first"                          |
| Token refresh fails (revoked, network)                    | Return stale token if still valid; if expired, surface error to user                           |
| Concurrent refresh calls from parallel requests           | Single in-flight promise dedup in `cached()`                                                   |
| CUSTOM_LOADER for anthropic overwrites plugin's fetch     | Currently doesn't — anthropic loader only sets headers, not fetch. Note as fragile dependency. |
| `@ai-sdk/anthropic` rejects placeholder API key           | Matches CodexAuthPlugin pattern (`codex.ts:389`); custom fetch replaces auth before request    |

<!-- Review notes: Incorporated feedback from oracle review — added OAUTH_DUMMY_KEY pattern, auth precedence explanation, billing header clarification (system message not HTTP header), credential format specification, refresh dedup, graceful degradation, authorize flow for missing credentials, split Task 4 into discrete tasks. -->
