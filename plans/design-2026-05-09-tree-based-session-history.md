# Tree-Based Session History Design Spec

**Problem:** Brocode's session model is linear. Forking creates a new session with a suffixed name, cluttering the session list. Finding related forks requires searching all sessions. There's no way to explore alternatives within a single session or navigate between branches of the same conversation.

**Goal:** Sessions become tree-structured. Branching happens in-place at the message level — no new session is created. The session list shows one entry per logical conversation. Users navigate branches within a session via `/tree`. A `/clone` command extracts the current branch into a separate session when needed.

**Scope:**

In scope:
- Message-level tree structure via `parent_id` on `MessageTable`
- `leaf_id` on `SessionTable` to track current position
- Context building by walking leaf-to-root through the tree
- `/tree` TUI command for visual tree navigation and branch switching
- `/clone` command to extract the current active branch into a new session
- Branch summaries (LLM-generated) when switching away from a branch
- Configurable model for branch summarisation (defaults to active model)
- Per-branch compaction (compaction entries sit on a specific branch path)
- DB migration adding new columns

Out of scope:
- `/fork` as a separate command (covered by `/tree` + resubmit)
- Branch labels/bookmarks (deferred)
- Merging old forked sessions into unified trees
- Any changes to the session list/search UX beyond removing fork clutter

**Constraints:**
- Must use SQLite/Drizzle (existing storage layer)
- Existing sessions remain functional — linear messages with null `parent_id` are treated as implicitly chained by `time_created`
- No destructive migration of existing data
- Branch summaries are optional per-interaction (user chooses whether to summarise when switching branches)

**Success Criteria:**
- [ ] Messages have a `parent_id` column; tree structure is persisted in SQLite
- [ ] `leaf_id` on sessions tracks current position; navigating the tree updates it
- [ ] Context building walks leaf-to-root and produces correct linear message history
- [ ] `/tree` renders the session tree and allows selecting any node to continue from
- [ ] Selecting a user message in `/tree` places it in the editor for resubmission (new branch)
- [ ] Selecting an assistant/tool message in `/tree` moves the leaf there (continue from that point)
- [ ] `/clone` extracts the current active branch into a new standalone session
- [ ] Branch summaries are generated when switching branches (optional, user-prompted)
- [ ] Summarisation model is configurable, defaulting to the active model
- [ ] Compaction is per-branch (only affects the branch path it sits on)
- [ ] Existing linear sessions continue to work without migration beyond schema changes
- [ ] Session list shows one entry per session (no fork clutter)

**Design Decisions:**

- **In-place branching over child sessions:** Eliminates session list clutter and keeps related exploration together. The current `parent_id` on `SessionTable` (session-level) is left for existing data but not used for new branching.
- **`parent_id` on `MessageTable` over JSONL:** Fits naturally with existing Drizzle/SQLite storage. Avoids a format migration. Enables SQL queries for tree traversal.
- **`leaf_id` on `SessionTable`:** Single source of truth for "where am I in this tree." Resuming a session lands at the leaf.
- **Per-branch compaction over global:** Avoids invalidating sibling branches. Each compaction entry only affects its own root-to-leaf path.
- **Branch summaries included:** Critical for preserving context about abandoned approaches without replaying entire branches.
- **Configurable summarisation model:** Users may want a cheaper/faster model for summaries. Defaults to the active model to avoid configuration burden.
- **Leave existing forks as-is:** Low risk, avoids complex data migration. Old sessions with null `parent_id` on messages are implicitly linear.
- **No `/fork` command initially:** `/tree` navigation + resubmit covers the same workflow with one fewer concept to learn.

**Context Files:**
- `packages/opencode/src/session/session.sql.ts` — Drizzle schema for SessionTable, MessageTable, PartTable
- `packages/opencode/src/session/session.ts` — Session service (create, fork, list, etc.)
- `packages/opencode/src/session/schema.ts` — SessionID, MessageID, PartID branded types
- `packages/opencode/src/session/message.ts` — Message part schemas (ToolCall, TextPart, etc.)
- `packages/opencode/src/session/message-v2.ts` — MessageV2 module
- `packages/opencode/src/session/compaction.ts` — Compaction logic
- `packages/opencode/src/session/summary.ts` — Summary generation
- `packages/opencode/src/session/llm.ts` — LLM interaction / context building
- `packages/opencode/src/session/processor.ts` — Message processing pipeline

**Reference implementation:**
- Pi's `packages/coding-agent/src/core/session-manager.ts` — Tree structure, branching, context building
- Pi's `packages/coding-agent/docs/sessions.md` — UX documentation for /tree, /fork, /clone
- Pi's `packages/coding-agent/docs/session-format.md` — JSONL tree format and SessionManager API
