# Tree View Improvements Implementation Plan

> **Status:** DRAFT

## Specification

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
- Branch diffing
- Collapse state persistence across dialog opens

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

## Context Loading

_Run before starting any task group:_

```bash
read packages/opencode/src/cli/cmd/tui/ui/dialog-select.tsx
read packages/opencode/src/cli/cmd/tui/routes/session/dialog-tree.tsx
read packages/opencode/src/cli/cmd/tui/routes/session/index.tsx:500-540
read packages/opencode/src/cli/cmd/tui/ui/dialog.tsx:76-91
read packages/opencode/src/session/session.ts:600-620,760-785
read packages/opencode/src/session/message-v2.ts:384-415,561-601
read packages/opencode/src/session/session.sql.ts:56-72
read packages/opencode/src/session/projectors.ts:114-118
read packages/opencode/src/cli/cmd/tui/context/sync.tsx:292-304
read packages/opencode/src/config/keybinds.ts
```

## Tasks

### Change A: Sort Reversal + Filter Mode

#### Task 1: Reverse sibling sort order in tree view

**Context:** `packages/opencode/src/cli/cmd/tui/routes/session/dialog-tree.tsx`

**Files:**
- Modify: `packages/opencode/src/cli/cmd/tui/routes/session/dialog-tree.tsx` (reverse sort comparator)

**Steps:**

1. [ ] In `dialog-tree.tsx`, line 105, change the `walk()` sort from ascending to descending:
   ```ts
   // Before:
   const children = (childrenMap.get(parentID) ?? []).toSorted((a, b) => a.time.created - b.time.created)
   // After:
   const children = (childrenMap.get(parentID) ?? []).toSorted((a, b) => b.time.created - a.time.created)
   ```

**Verify:**
```bash
# Manual: open TUI, create a session with multiple branches, open tree view (<leader>t)
# Newest branch should appear first among siblings
```

---

#### Task 2: Add on-demand filter mode to DialogSelect

**Context:** `packages/opencode/src/cli/cmd/tui/ui/dialog-select.tsx`, `packages/opencode/src/cli/cmd/tui/ui/dialog.tsx`

**Files:**
- Modify: `packages/opencode/src/cli/cmd/tui/ui/dialog-select.tsx` (add `filterMode` prop, focus/keyboard management, inactive styling)

**Steps:**

1. [ ] Add `filterMode?: "always" | "on-demand"` prop to `DialogSelectProps` interface (line 16). Default behaviour remains `"always"` for backward compatibility.

2. [ ] Add `filterActive` boolean to the component's `createStore` (line 62). Initialize to `true` when `filterMode` is `"always"` or undefined, `false` when `"on-demand"`.

3. [ ] Modify the `<input>` rendering (lines 256-278):
   - When `filterMode` is `"on-demand"` and `filterActive` is `false`: render the input but do **not** call `input.focus()` in the `ref` callback. Apply muted styling (`focusedBackgroundColor` and `focusedTextColor` both set to `theme.backgroundPanel`/`theme.textMuted`, and change placeholder to something like `/ to filter`).
   - When `filterActive` is `true`: render normally (current behaviour), call `input.focus()`.

4. [ ] Add `/` key handler in `useKeyboard` (line 196):
   ```ts
   if (filterMode === "on-demand" && !store.filterActive && evt.name === "/") {
     evt.preventDefault()
     evt.stopPropagation()
     setStore("filterActive", true)
     // Focus the input on next tick
     setTimeout(() => input?.focus(), 1)
   }
   ```

5. [ ] Add `Esc` key handler in `useKeyboard`, **before** any other Esc handling, to deactivate filter when active:
   ```ts
   if (filterMode === "on-demand" && store.filterActive && evt.name === "escape") {
     evt.preventDefault()
     evt.stopPropagation()
     setStore("filterActive", false)
     setStore("filter", "")
     input?.blur()
     // Clear the input value if the input component holds internal state
     return // prevent dialog.tsx Esc handler from closing the dialog
   }
   ```
   This must call `evt.preventDefault()` and `evt.stopPropagation()` to prevent the outer `dialog.tsx` Esc handler (line 76-91) from closing the dialog.

6. [ ] Gate the `onInput` handler (line 257) so it only processes input when `filterActive` is `true`. When `filterActive` is `false`, the input should not accept keystrokes.

7. [ ] Expose `filterActive` state in the `DialogSelectRef` type so consumers can query it if needed.

**Verify:**
```bash
bun typecheck
# Manual: create a test dialog with filterMode="on-demand", verify:
# - Input starts inactive (muted styling, not focused)
# - "/" activates filter (focused, normal styling)
# - Typing filters the list
# - Esc deactivates filter (clears text, muted styling)
# - Second Esc closes the dialog
# - Existing dialogs (without filterMode prop) work unchanged
```

---

#### Task 3: Wire DialogTree to use on-demand filter mode

**Context:** `packages/opencode/src/cli/cmd/tui/routes/session/dialog-tree.tsx`

**Files:**
- Modify: `packages/opencode/src/cli/cmd/tui/routes/session/dialog-tree.tsx` (add filterMode prop to DialogSelect)

**Steps:**

1. [ ] In `dialog-tree.tsx` line 179, add `filterMode="on-demand"` to the `<DialogSelect>` component:
   ```tsx
   <DialogSelect
     title="Session Tree"
     options={options()}
     filterMode="on-demand"
     placeholder="/ to filter · Enter to select · Esc to cancel"
   />
   ```

2. [ ] Update the placeholder text to reflect the new activation pattern.

**Verify:**
```bash
bun typecheck
# Manual: open tree view, verify filter starts inactive, "/" activates, Esc deactivates
```

---

### Change B: Collapse/Expand + Delete

_Depends on Change A (needs Left/Right keys freed from filter input)._

#### Task 4: Add collapse/expand to tree view

**Context:** `packages/opencode/src/cli/cmd/tui/routes/session/dialog-tree.tsx`, `packages/opencode/src/cli/cmd/tui/ui/dialog-select.tsx`

**Files:**
- Modify: `packages/opencode/src/cli/cmd/tui/routes/session/dialog-tree.tsx` (collapse state, indicators, walk skipping)
- Modify: `packages/opencode/src/cli/cmd/tui/ui/dialog-select.tsx` (Left/Right keybind support)

**Steps:**

1. [ ] In `dialog-tree.tsx`, add collapse state using SolidJS `createSignal`:
   ```ts
   const [collapsed, setCollapsed] = createSignal(new Set<string>())
   ```

2. [ ] In the `walk()` function, after processing a node, check if it's collapsed before recursing into children:
   ```ts
   // After pushing the result option for this node:
   if (!collapsed().has(msg.id)) {
     walk(msg.id, depth + 1)
   }
   ```

3. [ ] Add `▸`/`▾` indicators to node display. Determine if a node has children via `childrenMap`. Modify the title construction (line 149):
   ```ts
   const hasChildren = (childrenMap.get(msg.id)?.length ?? 0) > 0
   const collapseIndicator = hasChildren
     ? collapsed().has(msg.id) ? "▸ " : "▾ "
     : "  "
   // Prepend to the existing title
   ```
   Remove the existing `hasBranches ? " ⑂" : ""` suffix since the collapse indicator replaces its purpose.

4. [ ] Each option needs to carry the message ID and metadata for keybind handlers. The `value` field currently holds the navigation target ID (tail ID for assistants). Add a secondary data structure to map option values back to the original message for collapse/expand:
   ```ts
   // Build a Map<optionValue, messageID> alongside the walk
   const optionToMsg = new Map<string, string>()
   ```
   Populate during `walk()`: `optionToMsg.set(tail?.id ?? msg.id, msg.id)`.

5. [ ] Add Left/Right keybindings to `DialogSelect` via the `keybind` prop from `DialogTree`. Pass two keybinds:
   ```tsx
   keybind={[
     {
       keybind: { name: "left" },
       title: "Collapse",
       onTrigger: (option) => {
         const msgID = optionToMsg.get(option.value)
         if (!msgID) return
         if (collapsed().has(msgID)) {
           // Already collapsed → select parent
           const msg = msgMap.get(msgID)
           const parentID = msg?.treeParentID
           if (parentID) {
             // Find the option with this parent's value and select it
             // This requires the DialogSelect ref to programmatically move selection
           }
         } else {
           // Has children → collapse
           const hasChildren = (childrenMap.get(msgID)?.length ?? 0) > 0
           if (hasChildren) {
             setCollapsed(prev => new Set([...prev, msgID]))
           }
         }
       },
     },
     {
       keybind: { name: "right" },
       title: "Expand",
       onTrigger: (option) => {
         const msgID = optionToMsg.get(option.value)
         if (!msgID) return
         if (collapsed().has(msgID)) {
           setCollapsed(prev => {
             const next = new Set(prev)
             next.delete(msgID)
             return next
           })
         }
         // Right on a leaf or already-expanded node → no-op
       },
     },
   ]}
   ```

6. [ ] The `keybind` handlers in `DialogSelect` (line 216-225) currently only fire when `keybind` prop items have a matching `Keybind.Info`. The Left/Right keys need to be handled differently — they should only trigger when the filter is **inactive** (`filterMode === "on-demand" && !store.filterActive`). Add this guard to the keybind matching loop, or handle Left/Right in the `DialogTree` component's own keyboard handler instead.

   **Approach**: Since `DialogSelect` already supports a `keybind` prop array, extend the `keybind` interface to accept an optional `disabled` function or check `filterActive` state. The simplest approach: the `keybind` items already have a `disabled` boolean — pass `disabled: filterActive()` from `DialogTree` (requires `DialogSelect` to expose `filterActive` via ref, done in Task 2).

7. [ ] For "Left on collapsed → select parent": use the `DialogSelectRef` to find the parent option's index and call a method to move selection. This may require adding a `moveTo(index)` or `selectValue(value)` method to `DialogSelectRef`. Alternatively, expose `moveTo` on the ref.

**Verify:**
```bash
bun typecheck
# Manual:
# - Open tree view with a multi-branch session
# - Verify ▾/▸ indicators on nodes with children
# - Left arrow on expanded node → collapses, children hidden, indicator becomes ▸
# - Right arrow on collapsed node → expands, children visible, indicator becomes ▾
# - Left arrow on already-collapsed node → selection moves to parent
# - Right arrow on leaf → nothing happens
# - Activate filter with "/" → Left/Right move cursor in filter input
```

---

#### Task 5: Add subtree deletion

**Context:** `packages/opencode/src/session/session.ts`, `packages/opencode/src/session/projectors.ts`, `packages/opencode/src/session/message-v2.ts`, `packages/opencode/src/cli/cmd/tui/routes/session/dialog-tree.tsx`, `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx`, `packages/opencode/src/server/routes/instance/session.ts`

**Files:**
- Modify: `packages/opencode/src/session/message-v2.ts` (add `SubtreeRemoved` event)
- Modify: `packages/opencode/src/session/session.ts` (add `removeSubtree` method)
- Modify: `packages/opencode/src/session/projectors.ts` (add projector for subtree removal)
- Modify: `packages/opencode/src/cli/cmd/tui/context/sync.tsx` (add handler for subtree removal)
- Modify: `packages/opencode/src/server/routes/instance/session.ts` (add route or extend existing)
- Modify: `packages/opencode/src/cli/cmd/tui/routes/session/dialog-tree.tsx` (add `d` keybind, confirmation, ancestor guard)
- Modify: `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx` (wire `onDelete` prop)

**Steps:**

1. [ ] In `message-v2.ts`, add a new sync event for subtree removal:
   ```ts
   export const SubtreeRemoved = SyncEvent.define("message.subtree_removed", {
     sessionID: SessionID,
     messageIDs: Schema.Array(MessageID),
   })
   ```

2. [ ] In `session.ts`, add `removeSubtree` method:
   ```ts
   const removeSubtree = Effect.fn("Session.removeSubtree")(function* (input: {
     sessionID: SessionID
     messageID: MessageID
   }) {
     // Read all messages for the session to build the children map
     const messages = yield* MessageV2.stream(input.sessionID).pipe(Stream.runCollect, Effect.map(Chunk.toReadonlyArray))
     
     // Collect all descendant IDs via BFS/DFS from input.messageID
     const toDelete: MessageID[] = []
     const queue = [input.messageID]
     const childrenMap = new Map<MessageID, MessageID[]>()
     for (const msg of messages) {
       if (!msg.treeParentID) continue
       if (!childrenMap.has(msg.treeParentID)) childrenMap.set(msg.treeParentID, [])
       childrenMap.get(msg.treeParentID)!.push(msg.id)
     }
     while (queue.length > 0) {
       const id = queue.pop()!
       toDelete.push(id)
       for (const childID of childrenMap.get(id) ?? []) {
         queue.push(childID)
       }
     }
     
     yield* sync.run(MessageV2.SubtreeRemoved, {
       sessionID: input.sessionID,
       messageIDs: toDelete,
     })
     return toDelete
   })
   ```

3. [ ] In `projectors.ts`, add a projector for `SubtreeRemoved` that deletes all messages in a single call using `inArray`:
   ```ts
   SyncEvent.project(MessageV2.SubtreeRemoved, (db, data) => {
     db.delete(MessageTable)
       .where(and(inArray(MessageTable.id, data.messageIDs), eq(MessageTable.session_id, data.sessionID)))
       .run()
   })
   ```
   This runs as a single SQL `DELETE WHERE id IN (...)` statement. Parts are auto-deleted via CASCADE on `PartTable.message_id`. The projector runs synchronously in a single Drizzle call, so no partial-failure risk.

4. [ ] In `sync.tsx`, add handler for `"message.subtree_removed"`. Must clean up both `store.message` and `store.part` entries (the existing `message.removed` handler has a pre-existing bug where it doesn't clean up parts — fix that too):
   ```ts
   case "message.subtree_removed": {
     const idSet = new Set(event.properties.messageIDs)
     setStore(
       "message",
       event.properties.sessionID,
       produce((draft) => {
         for (let i = draft.length - 1; i >= 0; i--) {
           if (idSet.has(draft[i].id)) draft.splice(i, 1)
         }
       }),
     )
     // Clean up parts from reactive store to avoid memory leaks
     for (const id of event.properties.messageIDs) {
       setStore("part", id, undefined as any)
     }
     break
   }
   ```
   Also fix the existing `message.removed` handler (lines 292-304) to clean up `store.part[messageID]` after splicing the message — same pattern as above but for a single ID.

5. [ ] Add a server route for subtree deletion in `session.ts` (the routes file). Add a new DELETE endpoint, or add it as a query parameter on the existing delete route. A clean approach is a new route:
   ```
   DELETE /:sessionID/subtree/:messageID
   ```
   This calls `session.removeSubtree(...)` after `assertNotBusy`. Follow the same pattern as the existing `deleteMessage` route (lines 745-783), including the `assertNotBusy` guard.

6. [ ] In `dialog-tree.tsx`, add the `d` keybind. Before deleting:
   - Check if the selected node or any of its descendants are in the `ancestorSet` (current branch). If so, show an error notice and return.
   - Count the descendants for the confirmation prompt.
   - Show a confirmation: "Delete this message and N descendants? (y/N)". This can be a simple inline prompt or a second dialog.

   Add `onDelete` prop to `DialogTree`:
   ```ts
   export function DialogTree(props: {
     sessionID: string
     leafID?: string
     onBranch: (messageID: string, prompt?: PromptInfo) => void
     onDelete?: (messageID: string) => Promise<void>
   })
   ```

   Add `d` keybind to the `keybind` array passed to `DialogSelect`:
   ```ts
   {
     keybind: { name: "d" },
     title: "Delete",
     side: "right",
     onTrigger: async (option) => {
       const msgID = optionToMsg.get(option.value)
       if (!msgID) return
       // Check ancestor guard
       if (ancestorSet.has(msgID)) {
         // Show error: "Cannot delete current branch"
         return
       }
       // Count descendants
       const count = countDescendants(msgID, childrenMap)
       // Show confirmation
       // On confirm: call props.onDelete?.(msgID)
     },
   }
   ```

7. [ ] In `session/index.tsx`, wire the `onDelete` prop:
   ```tsx
   <DialogTree
     sessionID={currentSession.id}
     leafID={currentSession.leafID ?? undefined}
     onBranch={...}
     onDelete={async (messageID) => {
       await sdk.client.session.removeSubtree({
         sessionID: currentSession.id,
         messageID,
       })
     }}
   />
   ```
   This requires the SDK client to have the new route. The SDK is auto-generated from the server routes — run `./packages/sdk/js/script/build.ts` after adding the route.

8. [ ] For the confirmation prompt: implement as a temporary state in `DialogTree` that replaces the footer area or shows an inline "y/N" prompt. When in confirmation state, only `y` and `n`/`Esc` are handled. On `y`, execute delete and reset state. On `n`/`Esc`, cancel and reset state.

**Verify:**
```bash
bun typecheck
./packages/sdk/js/script/build.ts  # Regenerate SDK
# Manual:
# - Open tree view, select a non-current branch node
# - Press "d" → confirmation shows with message count
# - Press "y" → subtree disappears, tree stays open
# - Press "d" on a current-branch node → error notice, no confirmation
# - Start a streaming response, open tree, press "d" → error notice about busy session
```

---

### Change C: Branch Labels

_Independent of A/B, but benefits from on-demand filter mode (frees `l` key)._

#### Task 6: Add label field to message schemas

**Context:** `packages/opencode/src/session/message-v2.ts`

**Files:**
- Modify: `packages/opencode/src/session/message-v2.ts` (add `label` to `messageBase`)

**Steps:**

1. [ ] In `message-v2.ts`, add `label` to the `messageBase` struct (line 384):
   ```ts
   const messageBase = {
     id: MessageID,
     sessionID: SessionID,
     treeParentID: Schema.optional(MessageID),
     label: Schema.optional(Schema.String),
   }
   ```
   This automatically adds `label` to both `User` and `Assistant` schemas since they spread `...messageBase`. The `data` JSON column in `MessageTable` will include `label` when present. No DB migration needed — absent field reads as `undefined`.

2. [ ] Verify that `updateMessage` in `session.ts` (line 604) will persist the label. It fires `MessageV2.Event.Updated` with the full message struct, and the projector upserts the entire `data` blob. No changes needed — the existing flow handles new optional fields automatically.

**Verify:**
```bash
bun typecheck
```

---

#### Task 7: Add label server route, editing, and display to tree view

**Context:** `packages/opencode/src/cli/cmd/tui/routes/session/dialog-tree.tsx`, `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx`, `packages/opencode/src/server/routes/instance/session.ts`, `packages/opencode/src/session/session.ts`

**Files:**
- Modify: `packages/opencode/src/server/routes/instance/session.ts` (add PATCH route for message label)
- Modify: `packages/opencode/src/session/session.ts` (add `setLabel` method or expose label update)
- Modify: `packages/opencode/src/cli/cmd/tui/routes/session/dialog-tree.tsx` (label display, `l` keybind, inline editing)
- Modify: `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx` (wire `onLabel` prop)

**Steps:**

1. [ ] Add a `setLabel` method to `Session.Service` in `session.ts` that reads the message, sets the label field, and calls `updateMessage`:
   ```ts
   const setLabel = Effect.fn("Session.setLabel")(function* (input: {
     sessionID: SessionID
     messageID: MessageID
     label: string | undefined
   }) {
     const msg = yield* MessageV2.fromID(input.sessionID, input.messageID)
     const updated = { ...msg, label: input.label }
     yield* sync.run(MessageV2.Event.Updated, { sessionID: input.sessionID, info: updated })
     return updated
   })
   ```
   Note: `updateMessage` also advances `leafID` which is undesirable for a label update. Use `sync.run(MessageV2.Event.Updated, ...)` directly instead, which just persists without the leafID side effect. Check whether `MessageV2.fromID` exists or if messages need to be read via `stream` + filter.

2. [ ] Add a PATCH route in `server/routes/instance/session.ts` for setting a message label:
   ```
   PATCH /:sessionID/message/:messageID/label
   Body: { label?: string }
   ```
   This calls `session.setLabel(...)`. Follow the same pattern as existing routes. No `assertNotBusy` needed — labeling is safe during streaming.

3. [ ] Regenerate the SDK: `./packages/sdk/js/script/build.ts`

4. [ ] In `dialog-tree.tsx`, modify the preview display to show labels. In the title construction (around line 149):
   ```ts
   const labelPrefix = msg.label ? `[${msg.label}] ` : ""
   // title: `${indent}${branchMarker}${collapseIndicator}${role}: ${labelPrefix}${preview}...`
   ```

5. [ ] Add `onLabel` prop to `DialogTree`:
   ```ts
   onLabel?: (messageID: string, label: string | undefined) => Promise<void>
   ```

6. [ ] **Primary UX — inline row editing**: Add editing state to the component:
   ```ts
   const [editingLabel, setEditingLabel] = createSignal<{ msgID: string; value: string } | null>(null)
   ```

   When `editingLabel` is set, the option for that message should render an `<input>` element instead of the normal text display. This requires modifying how the option is constructed:
   - When `editingLabel()?.msgID === msg.id`, set the option's `title` to an empty string and use a custom rendering approach. Since `DialogSelectOption` doesn't support custom JSX in the title, the most practical approach is:
     - Use the `gutter` prop on the option (which renders custom JSX) to render an inline input
     - Or modify `DialogSelect` to support a `renderItem` override

   **Fallback UX** — if inline editing proves too complex with the current `DialogSelect` architecture:
   - When `l` is pressed, change the filter input area to show "Label:" as the placeholder, focus it, pre-fill with existing label
   - On Enter: save the label, restore normal filter input
   - On Esc: cancel, restore normal filter input

   Implement the fallback first as it's simpler and proven to work with the existing component structure. The inline version can be iterated on later.

7. [ ] Add `l` keybind to the `keybind` array:
   ```ts
   {
     keybind: { name: "l" },
     title: "Label",
     onTrigger: (option) => {
       const msgID = optionToMsg.get(option.value)
       if (!msgID) return
       const msg = msgMap.get(msgID)
       // Enter label editing mode
       setEditingLabel({ msgID, value: msg?.label ?? "" })
     },
   }
   ```

8. [ ] Handle Enter/Esc during label editing:
   - Enter: call `props.onLabel?.(editingLabel().msgID, editingLabel().value || undefined)`, clear editing state
   - Esc: clear editing state without saving

9. [ ] In `session/index.tsx`, wire the `onLabel` prop:
   ```tsx
   <DialogTree
     sessionID={currentSession.id}
     leafID={currentSession.leafID ?? undefined}
     onBranch={...}
     onDelete={...}
     onLabel={async (messageID, label) => {
       await sdk.client.session.setLabel({
         sessionID: currentSession.id,
         messageID,
         label,
       })
     }}
   />
   ```

10. [ ] Ensure labels are included in fuzzy search when filter is active. The fuzzy search in `DialogSelect` already searches `title` and `category` — since the label is part of the title string (`[my label] preview`), it will automatically be searchable. No additional work needed.

**Verify:**
```bash
bun typecheck
./packages/sdk/js/script/build.ts  # Regenerate SDK if routes changed
# Manual:
# - Open tree view, select a node, press "l"
# - Type a label, press Enter → label appears as [my label] before preview
# - Press "l" again → pre-filled with existing label
# - Clear label and Enter → label removed, preview returns to normal
# - Activate filter with "/" → type part of label → node appears in filtered results
# - Fork/clone session → labels preserved on copied messages
```

<!-- Review notes:
- Reviewed by devils-advocate agent (two rounds)
- Round 1 findings incorporated:
  - removeSubtree uses single inArray DELETE (not loop) for atomicity
  - sync.tsx subtree_removed handler cleans up store.part entries to avoid memory leak
  - Also fix pre-existing bug: message.removed handler doesn't clean up parts
  - Label persistence needs a new PATCH route — updateMessage is not exposed via HTTP. Added setLabel method + route (Task 7 steps 1-3)
  - setLabel avoids updateMessage's leafID advancement side effect by calling sync.run directly
- Round 2 findings noted:
  - filterMode requires careful focus routing — Task 2 steps are detailed but implementer should validate input.blur()/focus() behaviour
  - Inline label editing (Task 7 primary UX) is high-risk — DialogSelect doesn't support custom JSX per-row rendering. Plan specifies fallback UX as initial implementation path.
  - Left-on-collapsed → select-parent requires exposing moveTo on DialogSelectRef (Task 4 step 7)
  - d keybind only fires inside tree dialog context, won't leak to session view (separate keyboard handler scope)
  - lastContinuation() and continuation skipping are order-independent (use childrenMap lookups, not array position) — sort reversal is safe
-->
