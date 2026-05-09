# Tree-Based Session History Implementation Plan

> **Status:** DRAFT

## Specification

**Problem:** Brocode's session model is linear. Forking creates a new session with a suffixed name, cluttering the session list. Finding related forks requires searching all sessions. There's no way to explore alternatives within a single session or navigate between branches of the same conversation.

**Goal:** Sessions become tree-structured with in-place branching at the message level. One session = one entry in the session list. Users navigate branches via `/tree`, extract branches via `/clone`, and optionally get LLM-generated branch summaries when switching paths.

**Scope:** Message-level tree via `tree_parent_id` on `MessageTable`, `leaf_id` on `SessionTable`, tree-aware context building, `/tree` TUI command, `/clone` command, branch summaries with configurable model, per-branch compaction. Revert on branched sessions is a known limitation (out of scope).

**Success Criteria:**

- [ ] Messages have a `tree_parent_id` column with index on `(session_id, tree_parent_id)`
- [ ] `leaf_id` on sessions tracks current position
- [ ] Context building walks leaf-to-root via `tree_parent_id`
- [ ] `filterCompacted` is tree-aware (scoped to current branch path)
- [ ] `/tree` renders the session tree and allows selecting any node
- [ ] `/clone` extracts current active branch into a new session (messages + parts)
- [ ] Branch summaries are generated when switching branches (optional)
- [ ] Summarisation model is configurable, defaulting to active model
- [ ] Existing linear sessions continue to work

## Context Loading

_Run before starting:_

```bash
read packages/opencode/src/session/session.sql.ts
read packages/opencode/src/session/session.ts
read packages/opencode/src/session/message-v2.ts
read packages/opencode/src/session/schema.ts
read packages/opencode/src/session/compaction.ts
read packages/opencode/src/session/prompt.ts
read packages/opencode/src/session/projectors.ts
read packages/opencode/src/session/summary.ts
glob packages/opencode/src/session/**/*.ts
glob packages/opencode/src/cli/**/*.tsx
```

## Phase 1: Schema & Data Layer

### Task 1: Add tree columns, update projectors, generate migration

**Context:** `packages/opencode/src/session/session.sql.ts`, `packages/opencode/src/session/projectors.ts`, `packages/opencode/src/session/schema.ts`

**Files:**
- Modify: `packages/opencode/src/session/session.sql.ts` (add columns + index)
- Modify: `packages/opencode/src/session/projectors.ts` (update message projector to write `tree_parent_id`, add `leaf_id` update)
- Create: migration via `bun run db generate --name tree-parent`

**Steps:**

1. [ ] Add `tree_parent_id` column to `MessageTable`: `text().$type<MessageID>()` — nullable. This represents the tree structure for branching. It is distinct from `MessageV2.Assistant.parentID` (stored in the JSON `data` blob) which is the reply-to semantic link.
2. [ ] Add `leaf_id` column to `SessionTable`: `text().$type<MessageID>()` — nullable. Null means "latest message by time_created" (backward compat for pre-migration sessions).
3. [ ] Add index: `index("message_session_tree_parent_idx").on(table.session_id, table.tree_parent_id)` to `MessageTable`.
4. [ ] Update the `MessageV2.Event.Updated` projector at `projectors.ts:89–107`. Currently it inserts `{ id, session_id, time_created, data: rest }`. Add `tree_parent_id` to the insert values, reading it from `data.info.treeParentID` (a new field on the info object that gets stripped from the JSON blob before storage, same pattern as `id` and `sessionID`):
   ```
   const { id, sessionID, treeParentID, ...rest } = data.info
   db.insert(MessageTable).values({
     id,
     session_id: sessionID,
     time_created,
     tree_parent_id: treeParentID ?? null,
     data: rest,
   })
   ```
5. [ ] Add a new projector (or extend the existing message projector) that updates `SessionTable.leaf_id` whenever a message is inserted. After the message insert, run:
   ```
   db.update(SessionTable)
     .set({ leaf_id: id })
     .where(eq(SessionTable.id, sessionID))
     .run()
   ```
   This ensures `leaf_id` stays current as messages are appended.
6. [ ] Run `bun run db generate --name tree-parent` from `packages/opencode` to generate the migration.

**Verify:**
```bash
bun run db generate --name tree-parent
bun typecheck
```

### Task 2: Wire `tree_parent_id` into message creation paths

**Context:** `packages/opencode/src/session/message-v2.ts`, `packages/opencode/src/session/session.ts`, `packages/opencode/src/session/prompt.ts`, `packages/opencode/src/session/compaction.ts`

**Files:**
- Modify: `packages/opencode/src/session/message-v2.ts` (add `treeParentID` to `Info` union, update `info()` mapper at ~line 679)
- Modify: `packages/opencode/src/session/session.ts` (add `leafID` to `Session.Info`, update `fromRow()` at ~line 60)
- Modify: `packages/opencode/src/session/prompt.ts` (set `treeParentID` in `createUserMessage` at ~line 948)
- Modify: `packages/opencode/src/session/processor.ts` (set `treeParentID` when creating assistant messages at ~line 112)
- Modify: `packages/opencode/src/session/compaction.ts` (set `treeParentID` in `create()` at ~line 580 when creating compaction user messages)

**Steps:**

1. [ ] Add `treeParentID?: MessageID` to the `MessageV2.Info` base type (shared by User, Assistant, etc.). In the `info()` mapper (~line 679), read it from `row.tree_parent_id` (a DB column, not from `row.data`): `treeParentID: row.tree_parent_id ?? undefined`.
2. [ ] Add `leafID?: MessageID` to `Session.Info`. In `fromRow()` (~line 60), map: `leafID: row.leaf_id ?? undefined`.
3. [ ] In `prompt.ts`, in `createUserMessage` (~line 948): before creating the user message, read the session's `leafID`. Set `treeParentID` on the new user message info to the session's `leafID` (or undefined if null/legacy session). The projector in Task 1 will then auto-update `leaf_id` to this new message.
4. [ ] In `processor.ts`, in `create` (~line 112): when creating the assistant message, set `treeParentID` to the user message ID that triggered it (available as the parent message in the processor context).
5. [ ] In `compaction.ts`, in `create()` (~line 580): when creating the compaction user message, set `treeParentID` to the session's current `leafID`, same pattern as step 3.
6. [ ] Audit all other message creation paths. Search for all calls to `session.updateMessage()` and `MessageV2.Event.Updated` to ensure every message creation sets `treeParentID`. Key callers to check:
   - `prompt.ts:createUserMessage` (step 3)
   - `processor.ts:create` (step 4)
   - `compaction.ts:create` (step 5)
   - Any other places that create messages (tool results, etc. — these should set `treeParentID` to the preceding message on the branch)

**Verify:**
```bash
bun typecheck
bun test --filter "session"
bun test --filter "message"
```

### Task 3: Add tree navigation functions — `branchTo`, `getChildren`, `getAncestorPath`

**Context:** `packages/opencode/src/session/session.ts`, `packages/opencode/src/session/message-v2.ts`

**Files:**
- Modify: `packages/opencode/src/session/session.ts` (add `branchTo`, `getChildren`)
- Modify: `packages/opencode/src/session/message-v2.ts` (add `getAncestorPath`, `streamBranch`)

**Steps:**

1. [ ] Add `branchTo(input: { sessionID: SessionID; messageID: MessageID })` to session service. This updates `SessionTable.leaf_id` to the given `messageID` via `patch()` and fires `Session.Updated`. When the next user message is created (Task 2 step 3), `treeParentID` will point to this leaf, creating a new branch.
2. [ ] Add `getChildren(input: { sessionID: SessionID; messageID: MessageID })` to `message-v2.ts`. SQL query: `SELECT * FROM message WHERE session_id = ? AND tree_parent_id = ?` using the index from Task 1 step 3. Returns `WithParts[]` (hydrated with parts).
3. [ ] Add `getAncestorPath(sessionID: SessionID, leafID?: MessageID)` to `message-v2.ts`. Algorithm:
   - Fetch ALL messages for the session in one query (avoid N+1): `SELECT id, tree_parent_id FROM message WHERE session_id = ?`
   - Build an in-memory map: `Map<MessageID, MessageID | null>` (id → tree_parent_id)
   - Walk from `leafID` (or session's stored `leaf_id`, or latest by `time_created`) to root via the map
   - Return ordered list of MessageIDs from root to leaf
   - For legacy sessions (all `tree_parent_id` null): fall back to `time_created` ordering
4. [ ] Add `streamBranch(sessionID: SessionID, leafID?: MessageID)` — calls `getAncestorPath` to get the ordered MessageID list, then fetches full `WithParts` for those IDs. Returns messages in root-to-leaf order. This replaces `stream()` for context-building purposes.
5. [ ] Keep the existing `stream()` function as-is (do NOT rename). It's still needed by callers that want all messages regardless of branch (`share-next.ts:275`, `session.ts:735` for `messages()` when used by fork/clone).

**Verify:**
```bash
bun typecheck
bun test --filter "session"
bun test --filter "message"
```

## Phase 2: Tree-Aware Context Building

### Task 4: Update context building to use branch-scoped messages

**Context:** `packages/opencode/src/session/message-v2.ts` (lines 1083–1138), `packages/opencode/src/session/prompt.ts` (lines 1425–1470), `packages/opencode/src/session/compaction.ts` (lines 106–122)

**Files:**
- Modify: `packages/opencode/src/session/message-v2.ts` (update `filterCompactedEffect` to use `streamBranch`)
- Modify: `packages/opencode/src/session/prompt.ts` (update `runLoop` context building)
- Modify: `packages/opencode/src/session/compaction.ts` (ensure `completedCompactions` receives branch-scoped input)

**Steps:**

1. [ ] Update `filterCompactedEffect` at line 1136 to call `streamBranch(sessionID)` instead of `stream(sessionID)`. The `filterCompacted` function itself (line 1083) doesn't need changes — it already works on an iterable of messages. By feeding it only the current branch's messages, compaction entries on sibling branches are automatically excluded.
2. [ ] In `prompt.ts` `runLoop` (~line 1437): the call to `MessageV2.filterCompactedEffect(sessionID)` already uses the updated function from step 1. No additional changes needed here — verify this is the case.
3. [ ] Verify `completedCompactions` in `compaction.ts` (~line 106): this receives a `messages` array from its caller. Trace all callers — `processCompaction` at ~line 346 calls `completedCompactions(history)` where `history` comes from `filterCompactedEffect`. Since `filterCompactedEffect` now uses `streamBranch`, the input is already branch-scoped. Confirm no other callers pass non-scoped messages.
4. [ ] Audit `session.ts:777` — `findMessage()` uses `MessageV2.stream(sessionID)` to search newest-first. This is used for `lastModel()` lookup (`prompt.ts:942`). Decide: should `findMessage` search only the current branch? **Yes** — update it to use `streamBranch` so it doesn't find models from sibling branches. The `streamBranch` result needs to be reversed (or `findMessage` needs to walk leaf-to-root).
5. [ ] Audit `tool/plan.ts:13` — uses `MessageV2.stream(sessionID)`. This scans for plan-related parts. It should search the current branch only. Update to use `streamBranch`.
6. [ ] `share-next.ts:275` and `session.ts:735` (`messages()` for all-messages use cases like fork) should keep using the existing `stream()` — these want all messages.
7. [ ] `page()` at line 1002 is used by the HTTP API / TUI to fetch messages for rendering. For now, leave it returning all messages (the TUI needs to display the tree, not just one branch). In a future iteration, `page()` could accept a `leafID` parameter to scope to a branch.

**Verify:**
```bash
bun typecheck
bun test --filter "compaction"
bun test --filter "message"
bun test --filter "prompt"
```

## Phase 3: TUI Commands

### Task 5: Register `/tree` command and build tree data model

**Context:** `packages/opencode/src/cli/`, existing slash command implementations

**Files:**
- Create: tree command registration and data model (location TBD — follow existing command patterns, look at how `/resume`, `/new`, `/compact` are registered)
- Modify: `packages/opencode/src/session/message-v2.ts` (add `getTree` function if not already covered by `getChildren`)

**Steps:**

1. [ ] Find the existing slash command registration pattern. Look at `/resume`, `/new`, `/compact` slash commands. Follow the same registration mechanism to add `/tree`.
2. [ ] Add a `getTree(sessionID: SessionID)` function to `message-v2.ts` (or session service): fetches all messages for a session, builds an in-memory tree structure using `tree_parent_id`. Returns a `TreeNode` type: `{ message: WithParts; children: TreeNode[] }`. For legacy messages (null `tree_parent_id`), chain linearly by `time_created`.
3. [ ] Register `/tree` as a slash command. On invocation, call `getTree(sessionID)` to load the tree data and pass it to the TUI renderer (Task 6).

**Verify:**
```bash
bun typecheck
```

### Task 6: Build `/tree` TUI renderer and selection behaviour

**Context:** `packages/opencode/src/cli/`, the tree data model from Task 5

**Files:**
- Create: tree renderer component (React/Ink component following existing TUI patterns)
- Modify: session service or prompt service for editor integration

**Steps:**

1. [ ] Build a full-screen tree renderer (React/Ink component). Display as indented tree with:
   - Message preview: first ~60 chars of text content, or `[tool: toolName]` for tool messages, or `[compaction]` for compaction messages
   - Role indicator: `U:` for user, `A:` for assistant
   - Highlight the current branch (path from root to current `leaf_id`) with distinct styling
   - Mark the current leaf position with a cursor/arrow
   - Show branch points (messages with multiple children) with a branch indicator
2. [ ] Navigation: up/down arrow keys move between visible nodes (depth-first traversal order), left/right to collapse/expand subtrees
3. [ ] On selecting a **user message**: call `session.branchTo(sessionID, selectedMessage.treeParentID)` — this moves the leaf to the *parent* of the selected message. Place the selected message's text content in the editor for resubmission. This creates a new branch when the user submits.
4. [ ] On selecting an **assistant/tool message**: call `session.branchTo(sessionID, selectedMessageID)` — moves the leaf to that message. Editor stays empty. User continues from that point.
5. [ ] Add filter modes toggled by `Ctrl+O`: all messages → user-only → branch-points-only. Default to "all messages".
6. [ ] Pressing Escape or `Ctrl+C` cancels and returns to the editor without changing the leaf.

**Verify:**
```bash
bun typecheck
# Manual testing: create a session with multiple turns, run /tree, navigate, select nodes
```

### Task 7: Implement `/clone` command

**Context:** `packages/opencode/src/session/session.ts` (fork at lines 643–683)

**Files:**
- Modify: `packages/opencode/src/session/session.ts` (add `clone` method)
- Modify: TUI command registry (register `/clone`)

**Steps:**

1. [ ] Add `clone(input: { sessionID: SessionID })` to session service:
   - Get the session's `leafID`
   - Call `getAncestorPath(sessionID, leafID)` to get the ordered list of MessageIDs on the current branch (root-to-leaf)
   - Create a new session via `createNext()`
   - Iterate messages in root-to-leaf order. For each message:
     - Allocate a new `MessageID`; track old→new in `idMap: Map<MessageID, MessageID>`
     - Remap `treeParentID` through `idMap` (the previous message in sequence)
     - If assistant: remap `parentID` (reply-to link) through `idMap`
     - Call `updateMessage()` with new sessionID and new IDs
     - Fetch all parts for the original message. For each part:
       - Allocate new `PartID`
       - If compaction part with `tail_start_id`: remap through `idMap`
       - Call `updatePart()` with new IDs
   - Set `leaf_id` on the new session to the last remapped message
   - The cloned session is linear (each `treeParentID` points to the previous in sequence, no branches)
2. [ ] Register `/clone` as a slash command. On execution: call `clone`, switch to the new session, display confirmation.

**Verify:**
```bash
bun typecheck
bun test --filter "session"
# Manual testing: create branches, /clone, verify new session has only current branch
```

## Phase 4: Branch Summaries & Guards

### Task 8: Branch summary generation when switching branches

**Context:** `packages/opencode/src/session/summary.ts`, `packages/opencode/src/session/compaction.ts` (for LLM call patterns), `packages/opencode/src/config/`

**Files:**
- Create: `packages/opencode/src/session/branch-summary.ts`
- Modify: `packages/opencode/src/session/message-v2.ts` (add `BranchSummaryPart` type)
- Modify: Task 6's `/tree` command handler (add summary prompt before branch switch)
- Modify: config module (add `summarisation_model` setting)

**Steps:**

1. [ ] Add `BranchSummaryPart` to message-v2 part types: `{ type: "branch_summary"; summary: string; fromLeafID: MessageID; model: string }`. This is a part on a user message, similar to `CompactionPart`.
2. [ ] Create `branch-summary.ts` with `generateBranchSummary`:
   - Input: messages on the branch being abandoned (from branch point to old leaf), the model to use
   - Calls `toModelMessages` to convert to LLM format
   - Runs a focused prompt: "Summarise what was attempted on this branch and the outcome. Be concise."
   - Returns the summary text
   - If the branch exceeds context limits, gracefully degrade: truncate to fit or skip summary with a warning
3. [ ] In the `/tree` command handler (Task 6): when the user selects a node that causes a branch switch (i.e., the selected node is not on the current branch path), prompt with options:
   - `(1)` No summary — proceed immediately
   - `(2)` Summarise — generate summary, create a user message at the new branch point with `BranchSummaryPart`, then proceed
4. [ ] The summary message's `treeParentID` should be the branch point (the message the user selected or its parent). This means the summary message is the first message on the new branch, appearing before the user's next prompt in context.
5. [ ] Add `summarisation_model` to config (follow existing config module patterns in `packages/opencode/src/config/`). If set, use that model. If not, use the session's active model.
6. [ ] In `toModelMessages` or `filterCompacted`: ensure `BranchSummaryPart` messages are included in context as user-role messages showing the summary text.

**Verify:**
```bash
bun typecheck
bun test --filter "summary"
bun test --filter "branch"
# Manual testing: switch branches, generate summary, verify it appears in context
```

### Task 9: Guard revert on branched sessions

**Context:** `packages/opencode/src/session/revert.ts`

**Files:**
- Modify: `packages/opencode/src/session/revert.ts` (add guard)

**Steps:**

1. [ ] In `revert()` (~line 43): before performing the revert, check if the session has any actual branch points. Query: `SELECT tree_parent_id, COUNT(*) as cnt FROM message WHERE session_id = ? AND tree_parent_id IS NOT NULL GROUP BY tree_parent_id HAVING cnt > 1`. If this returns any rows, the session has branches.
2. [ ] If branches exist, return an error: "Revert is not supported on sessions with branches. Use /tree to navigate to a previous point instead."
3. [ ] This is a known limitation documented in the design spec.

**Verify:**
```bash
bun typecheck
bun test --filter "revert"
```

<!-- Review notes:
- Addressed projector gap: Task 1 now explicitly modifies projectors.ts to write tree_parent_id and update leaf_id
- Addressed stream() caller audit: Task 4 audits all 4 callers (session.ts:735, session.ts:777, tool/plan.ts:13, share-next.ts:275) with explicit decisions per caller
- Addressed leaf_id persistence: projector side-effect updates leaf_id on every message insert
- Addressed getAncestorPath N+1: fetches all session messages in one query, builds in-memory map, walks from leaf to root
- Task 6 (TUI /tree) separated from Task 5 (data model + registration) to reduce scope per task
- Revert guard uses GROUP BY/HAVING query to correctly detect actual branch points, not just presence of tree_parent_id
- Branch summary treeParentID is the branch point, making it the first message on the new branch (not a sibling)
- Kept stream() as-is (no rename) — callers that need all messages keep using it unchanged
-->
