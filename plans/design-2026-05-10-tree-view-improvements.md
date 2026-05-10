# Tree View Improvements Design Spec

**Problem:** The tree view (`<leader>t`) is functional but lacks polish for daily use. Branches sort oldest-first (burying recent work), there's no way to collapse subtrees in large sessions, no way to clean up abandoned branches, and no way to label branches for quick identification.

**Goal:** Make the tree view a productive navigation and branch management tool — not just a read-only map. Users should be able to quickly find, organise, label, and clean up branches.

**Scope:**

In scope:
- Reverse sibling sort order (newest first)
- On-demand filter input mode in `DialogSelect` (activated by `/`, deactivated by `Esc`)
- Collapse/expand subtrees with `Left`/`Right` arrow keys
- Delete subtrees with `d` key + confirmation
- Branch labels on any message with `l` key + inline edit
- `removeSubtree` method on `Session.Service` for transactional subtree deletion

Out of scope:
- Branch diffing (file snapshots / git integration not available)
- Collapse state persistence across dialog opens

**Constraints:**
- Changes to `DialogSelect` (filter mode) must be backward-compatible — existing dialogs keep current always-active filter behaviour
- Delete must not allow removing the current branch (ancestor path to `leafID`)
- Delete must be refused if the session is busy (streaming) — show a brief error notice, tree stays open

**Success Criteria:**
- [ ] Branches sort newest-first among siblings; parent→child still flows downward
- [ ] `DialogSelect` supports `filterMode: "on-demand"` — input styled as inactive until `/` pressed, `Esc` deactivates
- [ ] Arrow keys (`Left`/`Right`) collapse/expand nodes when filter is inactive
- [ ] `Left` on an already-collapsed node moves selection to its parent; `Right` on a leaf does nothing
- [ ] `▸`/`▾` indicators on nodes with children; no indicator on leaves
- [ ] All nodes start expanded when tree dialog opens
- [ ] `d` key prompts confirmation with message count ("Delete this message and N descendants? (y/N)")
- [ ] Delete is refused if selected node is on the current branch (ancestor path)
- [ ] Delete is refused if session is busy (streaming) — shows error notice
- [ ] Tree stays open after deletion
- [ ] `leafID` unchanged after delete
- [ ] `l` key opens inline edit on the selected row to set/edit a label
- [ ] Labels display as `[my label]` before the preview text
- [ ] Any message (user or assistant) can be labeled
- [ ] Labels survive `fork`/`clone` operations

## Design Decisions

### Sort order (Q1)
Reverse sibling order only — newest branch renders first among siblings. Parent→child traversal remains top-down (depth-first, parent before children). This keeps the tree mental model intact while surfacing recent work at the top.

### Collapse behaviour (Q2–Q5)
Standard tree collapse: collapsing a node hides all its descendants. The collapsed node stays visible with a `▸` indicator; expanded nodes with children show `▾`. Leaf nodes show no indicator.

- Default state: all expanded on every dialog open. No persistence.
- Keybinding: `Left` collapses, `Right` expands (macOS Finder convention).
- Edge cases: `Left` on an already-collapsed node moves selection to its parent. `Right` on a leaf does nothing.
- Collapse state stored as `Set<string>` of collapsed message IDs, local to the dialog component.

### Filter input mode (Q5)
`DialogSelect` gains a new prop `filterMode?: "always" | "on-demand"` (default `"always"` for backward compatibility).

In `"on-demand"` mode:
- The filter input is always rendered but styled as inactive (muted/unfocused).
- Pressing `/` activates the filter (focuses input, normal styling).
- Pressing `Esc` while filter is active deactivates it (clears text, unfocuses, returns to navigation mode). If filter is already inactive, `Esc` closes the dialog as normal.
- When filter is inactive, all keyboard events go to navigation (arrows, `d`, `l`, etc.).
- When filter is active, `Left`/`Right` move the cursor in the input. `Up`/`Down` still navigate the list.
- Only `/` activates the filter — other printable characters do not.
- `d` and `l` keybindings only trigger when filter is inactive — when active, they type into the filter input.

### Delete (Q6–Q9)
- Deletes the selected message and all its descendants (full subtree).
- Refuses deletion if any message in the subtree is on the current branch (in the ancestor path from `leafID` to root).
- Refuses deletion if the session is busy (streaming). Shows a brief error notice; tree stays open.
- Keybinding: `d` key. Always shows a confirmation prompt with message count: "Delete this message and N descendants? (y/N)".
- Implementation: new `removeSubtree` method on `Session.Service` that collects all descendant message IDs and deletes them in a single SQLite transaction. This avoids partial-failure corruption from looping individual `removeMessage` calls.
- After deletion: tree view stays open, `leafID` unchanged, deleted nodes disappear from the tree.

Note: `d` is distinct from `ctrl+d` (`session_delete` — deletes entire session). These are different contexts (tree dialog vs session view) and different key combos, but implementers should be aware of the proximity.

### Branch labels (Q12–Q13)
- Any message (user or assistant) can be labeled.
- Keybinding: `l` key on the selected node (only when filter is inactive).
- Primary UX: the selected row transforms into an editable text input, pre-filled with existing label if any. `Enter` saves, `Esc` cancels.
- Fallback UX (if inline edit proves too complex): temporarily replace the filter input area with a "Label:" prompt input.
- Display: labeled messages show `[my label]` before the preview text. If no label, current preview behaviour unchanged.
- Storage: add optional `label?: string` field to both `User` and `Assistant` message schemas in `message-v2.ts`. Since the `data` column is JSON, no DB migration is needed — the field is simply absent on existing messages. Persist via the existing `updateMessage` path (patches message data and publishes sync events). Labels survive `fork`/`clone` automatically since those operations copy message data.
- Labels are included in fuzzy search when filter is active.

## Sequencing

### Change A: Sort reversal + filter mode (foundational)
1. Reverse sibling sort in `walk()` comparator
2. Add `filterMode` prop to `DialogSelect`
3. Implement `/` activation, `Esc` deactivation, inactive styling
4. `DialogTree` opts into `filterMode: "on-demand"`

### Change B: Collapse + delete (interactive features)
Depends on Change A (needs `Left`/`Right` keys freed from filter input).

1. Add `collapsed` `Set<string>` state to `DialogTree`
2. `walk()` skips children of collapsed nodes
3. `▸`/`▾` indicators on nodes with children
4. `Left`/`Right` keybindings for collapse/expand (with edge cases: `Left` on collapsed → select parent, `Right` on leaf → no-op)
5. `d` keybinding with confirmation prompt showing message count
6. Subtree collection and current-branch guard
7. Busy session guard — refuse delete with error notice if session is streaming
8. Add `removeSubtree` method to `Session.Service` — single-transaction deletion of a message and all descendants
9. Wire `onDelete` callback from `DialogTree` to the session service

### Change C: Branch labels
Independent of A/B, but benefits from the on-demand filter mode (frees `l` key).

1. Add `label?: string` to `User` and `Assistant` message schemas in `message-v2.ts`
2. `l` keybinding to enter label edit mode
3. Inline row editing (primary) or filter-input hijack (fallback)
4. Persist label via `updateMessage`
5. Display `[label]` prefix in tree view
6. Labels included in fuzzy search when filter is active

## Context Files
- `packages/opencode/src/cli/cmd/tui/routes/session/dialog-tree.tsx` — tree view component
- `packages/opencode/src/cli/cmd/tui/ui/dialog-select.tsx` — `DialogSelect` component (filter mode changes)
- `packages/opencode/src/cli/cmd/tui/context/keybind.tsx` — keybind system
- `packages/opencode/src/server/routes/instance/session.ts` — `removeMessage` endpoint and route definitions
- `packages/opencode/src/session/session.ts` — `Session.Service` with `removeMessage` (add `removeSubtree`)
- `packages/opencode/src/session/message-v2.ts` — message types (`User`, `Assistant` schemas — add `label` field)
- `packages/opencode/src/session/session.sql.ts` — `MessageTable` schema (JSON `data` column)
- `packages/opencode/src/config/keybinds.ts` — existing keybinds (`session_tree`, `session_delete`)
- `packages/opencode/src/cli/cmd/tui/context/sync.tsx` — sync store (`message.removed` handler)
