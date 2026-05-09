# Tree-Based Session History Design Spec

**Problem:** Brocode's session model is linear. Forking creates a new session with a suffixed name, cluttering the session list. Finding related forks requires searching all sessions. There's no way to explore alternatives within a single session or navigate between branches of the same conversation.

**Goal:** Sessions become tree-structured. Branching happens in-place at the message level — no new session is created. The session list shows one entry per logical conversation. Users navigate branches within a session via `/tree`. A `/clone` command extracts the current branch into a separate session when needed.

**Scope:**

In scope:
- Message-level tree structure via `tree_parent_id` on `MessageTable`
- `leaf_id` on `SessionTable` to track current position
- Context building by walking leaf-to-root through the tree
- `/tree` TUI command for visual tree navigation and branch switching
- `/clone` command to extract the current active branch into a new session (must deep-copy parts too)
- Branch summaries (LLM-generated) when switching away from a branch
- Configurable model for branch summarisation (defaults to active model)
- Per-branch compaction (compaction entries sit on a specific branch path)
- DB migration adding new columns and index on `(session_id, tree_parent_id)`
- Rewrite of `stream()`, `page()`, `filterCompacted()`, and `toModelMessages()` to be tree-aware

Out of scope:
- `/fork` as a separate command (covered by `/tree` + resubmit)
- Branch labels/bookmarks (deferred)
- Merging old forked sessions into unified trees
- Any changes to the session list/search UX beyond removing fork clutter
- Tree-aware revert (existing revert will not work on branched sessions; documented as known limitation)

**Constraints:**
- Must use SQLite/Drizzle (existing storage layer)
- Existing sessions remain functional — linear messages with null `tree_parent_id` are treated as implicitly chained by `time_created`
- No destructive migration of existing data
- Branch summaries are optional per-interaction (user chooses whether to summarise when switching branches)
- Single-client semantics for `leaf_id` — concurrent clients viewing different branches is not supported in this iteration

**Success Criteria:**
- [ ] Messages have a `tree_parent_id` column; tree structure is persisted in SQLite
- [ ] Index on `(session_id, tree_parent_id)` for efficient child lookups
- [ ] `leaf_id` on sessions tracks current position; navigating the tree updates it
- [ ] Context building walks leaf-to-root via `tree_parent_id` and produces correct linear message history
- [ ] `filterCompacted` is tree-aware (only considers compaction entries on the current branch path)
- [ ] `/tree` renders the session tree and allows selecting any node to continue from
- [ ] Selecting a user message in `/tree` places it in the editor for resubmission (new branch)
- [ ] Selecting an assistant/tool message in `/tree` moves the leaf there (continue from that point)
- [ ] `/clone` extracts the current active branch into a new standalone session (messages AND parts)
- [ ] Branch summaries are generated when switching branches (optional, user-prompted)
- [ ] Summarisation model is configurable, defaulting to the active model
- [ ] Compaction is per-branch (only affects the branch path it sits on)
- [ ] Existing linear sessions continue to work without migration beyond schema changes
- [ ] Session list shows one entry per session (no fork clutter)

**Design Decisions:**

- **`tree_parent_id` naming (not `parent_id`):** `MessageV2.Assistant` already has a `parentID` field meaning "the user message this reply is for" (used in compaction, summary, processor). The tree column is named `tree_parent_id` to avoid collision. These are distinct concepts: `parentID` = reply-to semantic link, `tree_parent_id` = tree structure for branching.
- **In-place branching over child sessions:** Eliminates session list clutter and keeps related exploration together. The current `parent_id` on `SessionTable` (session-level) is left for existing data but not used for new branching.
- **`tree_parent_id` on `MessageTable` over JSONL:** Fits naturally with existing Drizzle/SQLite storage. Avoids a format migration. Enables SQL queries for tree traversal.
- **`leaf_id` on `SessionTable`:** Single source of truth for "where am I in this tree." Resuming a session lands at the leaf. This is persisted in the DB, not per-client — single-client semantics are accepted for this iteration.
- **Per-branch compaction over global:** Avoids invalidating sibling branches. Each compaction entry only affects its own root-to-leaf path. `filterCompacted()` and `completedCompactions()` must be rewritten to scope by branch path, not linear scan.
- **Branch summaries included:** Critical for preserving context about abandoned approaches without replaying entire branches.
- **Configurable summarisation model:** Users may want a cheaper/faster model for summaries. Defaults to the active model to avoid configuration burden.
- **Leave existing forks as-is:** Low risk, avoids complex data migration. Old sessions with null `tree_parent_id` on messages are implicitly linear.
- **No `/fork` command initially:** `/tree` navigation + resubmit covers the same workflow with one fewer concept to learn.
- **Revert excluded from tree support:** `revert.ts` uses linear ID comparison (`msg.info.id >= rev.messageID`) which doesn't work with tree structure. Revert on branched sessions is a known limitation for this iteration.
- **`/clone` deep-copies parts:** The actual content lives in `PartTable`, not `MessageTable`. `/clone` must copy both tables with remapped IDs, following the existing fork pattern in `session.ts:643-683`.

**Context Building Algorithm:**

1. Start at `leaf_id`, walk `tree_parent_id` chain to root, collecting message IDs
2. Reverse the collected path (root-to-leaf order)
3. If a compaction entry exists on the path:
   - Emit the compaction summary as the first context message
   - Include messages from `firstKeptEntryId` to the compaction point
   - Include messages after the compaction point to the leaf
4. Branch summary messages on the path are included as user-role context at their insertion point
5. Messages from sibling branches are never included

**Migration Strategy:**

Phased approach to reduce risk:
1. **Phase 1 — Schema:** Add `tree_parent_id` (nullable) to `MessageTable`, add `leaf_id` (nullable) to `SessionTable`, add index on `(session_id, tree_parent_id)`. Existing messages get null `tree_parent_id`.
2. **Phase 2 — Dual-path context building:** Rewrite `stream()`, `page()`, `filterCompacted()`, `toModelMessages()` to support both tree-walk (when `tree_parent_id` is populated) and legacy linear ordering (when null). New messages always populate `tree_parent_id`.
3. **Phase 3 — TUI commands:** Add `/tree` and `/clone` commands.
4. **Phase 4 — Branch summaries and compaction:** Add branch summary generation, per-branch compaction scoping, summarisation model config.

**Known Limitations:**
- Revert does not work on branched sessions (linear ID comparison assumption)
- `leaf_id` is per-session, not per-client — multiple clients viewing different branches simultaneously is not supported
- `/tree` performance for very deep trees (hundreds of messages) may need lazy loading in a future iteration
- Branch summary generation on context-overflow branches may fail; should gracefully degrade (skip summary, warn user)

**Context Files:**
- `packages/opencode/src/session/session.sql.ts` — Drizzle schema for SessionTable, MessageTable, PartTable
- `packages/opencode/src/session/session.ts` — Session service (create, fork, list, etc.)
- `packages/opencode/src/session/schema.ts` — SessionID, MessageID, PartID branded types
- `packages/opencode/src/session/message.ts` — Message part schemas (ToolCall, TextPart, etc.)
- `packages/opencode/src/session/message-v2.ts` — MessageV2 module (stream, page, filterCompacted, toModelMessages)
- `packages/opencode/src/session/compaction.ts` — Compaction logic (completedCompactions, filterCompacted)
- `packages/opencode/src/session/summary.ts` — Summary generation
- `packages/opencode/src/session/llm.ts` — LLM interaction / context building
- `packages/opencode/src/session/processor.ts` — Message processing pipeline
- `packages/opencode/src/session/revert.ts` — Revert logic (known limitation with tree structure)

**Reference implementation:**
- Pi's `packages/coding-agent/src/core/session-manager.ts` — Tree structure, branching, context building
- Pi's `packages/coding-agent/docs/sessions.md` — UX documentation for /tree, /fork, /clone
- Pi's `packages/coding-agent/docs/session-format.md` — JSONL tree format and SessionManager API
