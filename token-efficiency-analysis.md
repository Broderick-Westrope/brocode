# OpenCode vs Claude Code: Token Efficiency Analysis

## Executive Summary

OpenCode is less token-efficient than Claude Code across **five main dimensions**: output token reservation, per-message aggregate limits, cache-aware context management, tool result persistence, and output token capping. The system prompt and tool description sizes are actually comparable (or even slightly smaller for OpenCode), so the problem isn't the static payload -- it's **how context grows and how unused capacity is reserved**.

---

## 1. No Output Token Capping (HIGH impact)

**Claude Code**: Defaults to requesting only **8,000 max output tokens** per API call (`CAPPED_DEFAULT_MAX_TOKENS`). Data shows p99 output is ~4,911 tokens, so 32K is massive over-reservation. If the model hits the 8K cap, Claude Code transparently escalates to 64K on retry.

**OpenCode**: Always requests the full **32,000** (`OUTPUT_TOKEN_MAX`) or the model's declared limit. No escalation strategy. No recovery on exhaustion.

| | Claude Code | OpenCode |
|--|------------|---------|
| Default max output | 8,000 | 32,000 |
| Escalation on hit | -> 64,000 | None |
| Multi-turn recovery | Injects "resume" prompt | None |

**Impact**: This doesn't directly consume *input* tokens, but it affects the provider's slot scheduling. Anthropic reserves output capacity per request -- requesting 32K when you need 2K wastes serving capacity and may increase latency. For third-party providers that bill per-reserved-token, this is direct cost waste.

**Recommendation**: Add a two-phase output cap strategy:
- Default `maxOutputTokens` to 8,000-12,000
- If the model returns a `stop_reason: max_tokens` (or AI SDK equivalent), retry the same request at 64K
- On second exhaustion, inject a continuation prompt

**Key files**:
- OpenCode: `packages/opencode/src/session/llm.ts:161-164`
- Claude Code: `src/services/api/claude.ts:3394-3418`, `src/query.ts:1188-1221`

---

## 2. No Per-Message Aggregate Tool Result Budget (HIGH impact)

**Claude Code**: Enforces `MAX_TOOL_RESULTS_PER_MESSAGE_CHARS = 200,000` per user message. When N parallel tool calls produce results, the largest are persisted to disk if the aggregate exceeds budget. Uses a stable state machine (`frozen`/`fresh`/`mustReapply`) so replacement decisions never change, preserving prompt cache.

**OpenCode**: **No equivalent**. If 10 parallel Bash/Grep calls each return 50KB (the individual truncation limit), a single turn can inject **500KB** of tool results into context. This is the single largest source of token waste.

**Impact**: In a typical agentic loop, the model often issues 3-5 parallel tool calls. Without an aggregate cap, a single turn can consume 25-50% of the context window. This accelerates compaction triggers and wastes tokens on content that will shortly be pruned anyway.

**Recommendation**: Implement a per-message aggregate budget:
- Cap total tool results per assistant message at ~200K chars
- When exceeded, persist the largest results to disk and replace with a preview + file path
- Track replacement decisions stably across turns for cache coherence

**Key files**:
- OpenCode: No equivalent (gap)
- Claude Code: `src/utils/toolResultStorage.ts:49`, `src/query.ts:376-394`

---

## 3. Cache-Unaware Pruning (MEDIUM-HIGH impact)

**Claude Code**: Uses a **cache-editing API** (`CACHE_EDITING_BETA_HEADER`) that sends `cache_edits` blocks to delete old tool results from the server-side prompt cache *without* invalidating the cached prefix. This means micro-compaction is essentially free -- it removes tokens from context without forcing a full cache rebuild.

**OpenCode**: Pruning (`compaction.ts:59-99`) modifies message content locally by setting `time.compacted`, which causes `[Old tool result content cleared]` to be sent. This **breaks the prompt cache** on every prune, forcing the provider to re-cache the entire prompt prefix.

**Impact**: Every time OpenCode prunes old tool results (which happens whenever accumulated tool results exceed 40K tokens), the entire system prompt + conversation history must be re-ingested. For a 100K-token conversation, that's ~100K tokens of cache-miss read cost per prune operation.

**Recommendation**: This is harder to fix as it depends on provider support. For the Anthropic provider:
- Investigate if the cache-editing beta is available to third parties
- If not, at minimum: **batch prune operations** so pruning happens less frequently but removes more content at once, reducing the number of cache-busting events
- Consider pruning only at compaction time (which already breaks cache) rather than as a separate pre-step

**Key files**:
- OpenCode: `packages/opencode/src/session/compaction.ts:59-99`
- Claude Code: `src/services/compact/microCompact.ts:52-135`

---

## 4. Prompt Caching Strategy Differences (MEDIUM impact)

**Claude Code**: Places `cache_control` markers with **strategic scoping**:
- `scope: "global"` on static system prompt sections (shared across all users/sessions)
- `scope: "org"` on org-level content
- Up to **1-hour TTL** (`ttl: '1h'`) for eligible users
- Exactly ONE ephemeral cache breakpoint per request on the latest message
- **Beta header latching**: Once a beta header is activated, it stays on for the session to prevent cache key changes

**OpenCode** (`transform.ts:174-212`): Places `cacheControl: { type: "ephemeral" }` on:
- First 2 system messages
- Last 2 non-system messages

No TTL, no scope differentiation, no latching strategy.

**Impact**: OpenCode's 4-breakpoint approach (2 system + 2 latest) is reasonable but misses the cache scope hierarchy. The bigger issue is the lack of latching -- if any provider option changes mid-session (e.g., a plugin transform), it can invalidate the entire cached prefix.

**Recommendation**:
- Latch provider options/beta headers at session start so they don't change mid-session
- Only place ONE cache breakpoint on conversation messages (the latest), not 2 -- the second-to-last message will already be cached from the prior request
- Consider the 2-part system prompt structure more carefully: ensure the "stable" part truly never changes within a session

**Key files**:
- OpenCode: `packages/opencode/src/provider/transform.ts:174-212`
- Claude Code: `src/services/api/claude.ts:3063-3237`

---

## 5. Compaction Trigger Timing (MEDIUM impact)

**Claude Code**: Triggers compaction at `effectiveWindow - 13,000` tokens (13K buffer). Has multiple fallback strategies: session memory compaction (lightweight), full compaction, reactive compaction on API error, and a blocking limit at `effectiveWindow - 3,000`.

**OpenCode**: Triggers when `count >= usable`, where `usable = input_limit - reserved`. The reserved defaults to `min(20,000, maxOutputTokens)`. No buffer beyond reserved. No circuit breaker. No fallback strategies.

**Impact**: OpenCode triggers compaction later (right at the boundary) and has no multi-tier fallback. This means:
- It more frequently hits actual context overflow errors before compaction can complete
- Failed compactions retry without limit, wasting tokens on doomed API calls
- No lightweight compaction alternative for minor overflow

**Recommendation**:
- Add a buffer (e.g., 10-15K tokens) before the hard limit to trigger compaction earlier
- Add a circuit breaker: after 2-3 failed compaction attempts, stop retrying
- Consider a lightweight "snip" mode that removes the oldest N tool results without a full summarization pass

**Key files**:
- OpenCode: `packages/opencode/src/session/compaction.ts:33-49`
- Claude Code: `src/services/compact/autoCompact.ts:33-91`

---

## 6. Tool Result Persistence Threshold (LOW-MEDIUM impact)

**Claude Code**: Has a configurable `getPersistenceThreshold()` per tool, defaulting to 50K chars. Results exceeding this are written to disk and replaced with a **2KB preview** wrapped in `<persisted-output>` tags. Tools can opt out (e.g., Read tool sets `maxResultSizeChars: Infinity`).

**OpenCode**: Truncates at 2,000 lines / 50KB but always sends the full truncated content. No concept of a small preview + file reference for large results. The truncated output itself can still be up to 50KB.

**Impact**: A Claude Code persisted result consumes ~2KB in context. An OpenCode truncated result can consume up to 50KB. For the same logical tool output, OpenCode may use **25x more context tokens**.

**Recommendation**:
- When truncation triggers, instead of sending the truncated head (which can still be large), send a short preview (2-5KB) + the file path
- The current truncation hint already tells the model to use Grep/Read, so the UX would be unchanged
- Allow per-tool threshold overrides (e.g., Read tool results might benefit from larger inline limits)

**Key files**:
- OpenCode: `packages/opencode/src/tool/truncate.ts:63-121`
- Claude Code: `src/constants/toolLimits.ts`, `src/utils/toolResultStorage.ts`

---

## 7. Skills in System Prompt (LOW-MEDIUM impact)

**OpenCode**: Lists ALL available skills with descriptions in the system prompt as verbose XML (`Skill.fmt(list, { verbose: true })`), `system.ts:55-67`. For a project with many skills installed, this can add thousands of tokens to every request.

**Claude Code**: Uses a **deferred tool discovery** pattern via `ToolSearchTool`. Skills/tools marked as `shouldDefer` aren't included in the tool array at all -- they're listed as lightweight text hints and only loaded when the model discovers them. The `defer_loading: true` flag on deferred tools means the API **doesn't count them** in the token budget.

**Impact**: With 20+ skills (common for Eucalyptus repos), the skills section can add 3-5K tokens to every system prompt. These tokens are paid on every request, even when the model never invokes any skill.

**Recommendation**:
- Move to a lighter skill listing format: name + one-line hint instead of full descriptions
- Load full skill descriptions only when the model invokes the Skill tool
- Consider a ToolSearch-like pattern where skill details are deferred

**Key files**:
- OpenCode: `packages/opencode/src/session/system.ts:55-67`
- Claude Code: `src/services/api/claude.ts:1120-1172`

---

## Prioritised Recommendations

| # | Change | Est. Token Savings | Effort |
|---|--------|-------------------|--------|
| 1 | **Per-message aggregate tool result budget** | 50-200K per burst turn | Medium |
| 2 | **Output token capping (8K default + escalation)** | Indirect (serving cost) | Low |
| 3 | **Tool result persistence with small preview** | Up to 48KB per tool call | Low |
| 4 | **Batch/minimise cache-breaking prune events** | 50-100K cache miss per prune | Medium |
| 5 | **Earlier compaction trigger + circuit breaker** | Prevents overflow waste | Low |
| 6 | **Lighter skill listing in system prompt** | 2-4K per request | Low |
| 7 | **Single cache breakpoint on latest message** | Minor cache efficiency | Trivial |

Items 1-3 are the highest-impact, most actionable changes. Item 1 alone would address the most common "context fills up too fast" scenario.

---

## Appendix: What OpenCode Already Does Well

For completeness, areas where OpenCode is comparable or has no significant gap:

- **System prompt size**: ~8.6K chars for Claude models vs Claude Code's ~13.2K. OpenCode is actually more concise here.
- **Tool description sizes**: Core tools (Bash, Read, Write, Edit) are within 2-25% of Claude Code. Total matched tool descriptions are ~22% smaller in OpenCode.
- **Provider-specific prompts**: OpenCode has separate optimised prompts for each model family (Gemini, GPT, Claude, etc.), which Claude Code does not.
- **Basic truncation**: Both use 50KB limits for individual tool results.
- **Basic compaction**: Both implement conversation summarisation when context fills up.
- **Prompt caching**: Both apply ephemeral cache control to system messages and recent turns.
